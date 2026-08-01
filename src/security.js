import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Hash de contrasena con scrypt + sal aleatoria por usuario. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Comparacion en tiempo constante: no filtra informacion por temporizacion. */
export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Codigo publico de la cita: legible por telefono, sin caracteres ambiguos. */
export function publicCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3) out += '-';
  }
  return out;
}

/**
 * La IP nunca se guarda en claro: se almacena un hash con sal del proceso.
 * Sirve para limitar abuso sin acumular datos personales innecesarios.
 */
const IP_SALT = process.env.IP_SALT || randomToken(16);
export const hashIp = (ip) => sha256(`${IP_SALT}:${ip}`).slice(0, 32);

export function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'desconocida';
}

/** Ventana fija de rate limiting persistida en SQLite. */
export function rateLimit(key, max, windowMinutes) {
  const now = Date.now();
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').get(key);
  const windowMs = windowMinutes * 60 * 1000;
  if (!row || now - Number(row.window_start) > windowMs) {
    db.prepare(`INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
                ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`)
      .run(key, String(now));
    return { allowed: true, remaining: max - 1 };
  }
  if (row.count >= max) return { allowed: false, remaining: 0 };
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return { allowed: true, remaining: max - row.count - 1 };
}

export function createSession(userId) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + config.sessionHours * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, csrf, expires);
  return { token, csrf };
}

export function getSession(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.id, s.csrf_token, s.expires_at, u.id AS user_id, u.name, u.email, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now() || !row.active) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  return row;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  const attrs = [
    `sid=${token}`,
    'HttpOnly',           // inaccesible desde JavaScript: mitiga robo por XSS
    'SameSite=Strict',    // el navegador no la envia desde otros sitios: mitiga CSRF
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secureCookies) attrs.push('Secure'); // solo viaja por HTTPS
  return attrs.join('; ');
}

export function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.secureCookies) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * Defensa CSRF en dos capas: cabecera Origin/Referer contra la lista blanca
 * y token de sesion enviado en X-CSRF-Token.
 */
export function originAllowed(req) {
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  if (!origin) return false;
  if (config.allowedOrigins.length > 0) return config.allowedOrigins.includes(origin);
  const host = req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
