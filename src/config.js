import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carga .env sin dependencias externas. Las variables ya presentes en el
// entorno tienen prioridad (asi manda la configuracion del hosting).
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Variable ${name} no es numerica: ${raw}`);
  return parsed;
};

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'si', 'yes'].includes(raw.toLowerCase());
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 3000),

  // Zona horaria de la parroquia. Toda la agenda se guarda y se muestra
  // en esta hora local (no en UTC) para evitar confusiones al reservar.
  timezone: process.env.APP_TIMEZONE || 'America/Bogota',
  parishName: process.env.PARISH_NAME || 'Parroquia San Jose',

  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'citas.db'),

  // Reglas de negocio del agendamiento.
  minLeadHours: num('MIN_LEAD_HOURS', 12),
  maxDaysAhead: num('MAX_DAYS_AHEAD', 60),
  maxPendingPerEmail: num('MAX_PENDING_PER_EMAIL', 3),
  retentionDays: num('RETENTION_DAYS', 540),

  // Seguridad.
  sessionHours: num('SESSION_HOURS', 8),
  loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
  loginWindowMinutes: num('LOGIN_WINDOW_MINUTES', 15),
  bookingMaxPerHour: num('BOOKING_MAX_PER_HOUR', 5),
  // Poner en true SOLO cuando el sitio se sirve por HTTPS (produccion).
  secureCookies: bool('SECURE_COOKIES', process.env.NODE_ENV === 'production'),
  // Confiar en X-Forwarded-For unicamente si hay un proxy inverso propio
  // delante (Nginx, Caddy, Cloudflare). Si no, un atacante falsea su IP.
  trustProxy: bool('TRUST_PROXY', false),
  // Origenes permitidos para peticiones que modifican datos.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

export const MAX_BODY_BYTES = 32 * 1024;
