import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, MAX_BODY_BYTES, ROOT } from './config.js';
import { audit, db } from './db.js';
import { HttpError } from './validate.js';
import { json } from './http.js';
import { routes } from './routes.js';
import {
  clientIp, hashIp, originAllowed, parseCookies, purgeExpiredSessions,
  securityHeaders, getSession,
} from './security.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'La solicitud es demasiado grande.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'La solicitud es demasiado grande.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('formato');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'El cuerpo de la solicitud no es JSON valido.');
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html'
    : pathname === '/panel' ? 'panel.html'
    : pathname === '/consulta' ? 'consulta.html'
    : pathname.slice(1);
  // Normalizar y confinar dentro de public/: bloquea ../../etc/passwd
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { error: 'Ruta no permitida.' });
  }
  const ext = path.extname(target).toLowerCase();
  if (!MIME[ext]) return json(res, 404, { error: 'No encontrado.' });
  try {
    const content = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    json(res, 404, { error: 'No encontrado.' });
  }
}

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (m) return { route, params: m.groups || {} };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'Solicitud invalida.' });
  }

  const ip = clientIp(req);
  const ctx = {
    req,
    res,
    url,
    ip,
    ipHash: hashIp(ip),
    query: Object.fromEntries(url.searchParams),
    cookies: parseCookies(req.headers.cookie || ''),
    body: {},
    params: {},
    session: null,
  };

  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'Metodo no permitido.' });
      }
      return await serveStatic(req, res, url.pathname);
    }

    const match = matchRoute(req.method, url.pathname);
    if (!match) return json(res, 404, { error: 'Recurso no encontrado.' });
    const { route, params } = match;
    ctx.params = params;

    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (mutating) {
      // Capa 1 anti-CSRF: la peticion debe venir del propio sitio.
      if (!originAllowed(req)) {
        return json(res, 403, { error: 'Origen no permitido para esta operacion.' });
      }
      ctx.body = await readJsonBody(req);
    }

    if (route.auth) {
      ctx.session = getSession(ctx.cookies.sid);
      if (!ctx.session) return json(res, 401, { error: 'Debe iniciar sesion.' });
      if (route.auth === 'admin' && ctx.session.role !== 'admin') {
        return json(res, 403, { error: 'Solo un administrador puede hacer esto.' });
      }
      // Capa 2 anti-CSRF: token de sesion en cabecera propia.
      if (mutating && req.headers['x-csrf-token'] !== ctx.session.csrf_token) {
        return json(res, 403, { error: 'Token de seguridad invalido. Recargue la pagina.' });
      }
    }

    await route.handler(ctx);
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    // Nunca se devuelve el detalle interno al cliente: solo al log del servidor.
    console.error(`[error] ${req.method} ${url.pathname}`, err);
    audit('sistema', 'error_interno', `${req.method} ${url.pathname}: ${err.code || err.name}`, ctx.ipHash);
    if (!res.headersSent) json(res, 500, { error: 'Ocurrio un error inesperado. Intente de nuevo.' });
  } finally {
    if (config.env !== 'test') {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 30_000;

/** Mantenimiento: sesiones vencidas y minimizacion de datos personales. */
function maintenance() {
  purgeExpiredSessions();
  db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(String(Date.now() - 86_400_000));
  const anonymized = db.prepare(`
    UPDATE appointments
       SET requester_name = 'Dato eliminado', requester_email = '', requester_phone = '',
           notes = '', updated_at = datetime('now')
     WHERE date < date('now', ?) AND requester_email <> ''`).run(`-${config.retentionDays} days`);
  if (anonymized.changes > 0) {
    audit('sistema', 'retencion_datos', `${anonymized.changes} citas anonimizadas`);
  }
}

if (config.env !== 'test') {
  maintenance();
  setInterval(maintenance, 6 * 3600 * 1000).unref();
  server.listen(config.port, config.host, () => {
    console.log(`Citas eclesiasticas escuchando en http://${config.host}:${config.port}`);
    console.log(`Zona horaria de la agenda: ${config.timezone} | cookies seguras: ${config.secureCookies}`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nRecibida senal ${signal}, cerrando...`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

export { server, maintenance };
