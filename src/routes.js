import { audit, db } from './db.js';
import { config } from './config.js';
import { json } from './http.js';
import { SERVICES } from './services.js';
import { findFreeSlot, slotsForRange } from './slots.js';
import { addDays, DAY_NAMES, localParts, stamp } from './time.js';
import {
  createSession, destroySession, hashPassword, publicCode, rateLimit,
  sessionCookie, sha256, verifyPassword,
} from './security.js';
import * as v from './validate.js';
import { HttpError } from './validate.js';

const routes = [];
const on = (method, path, handler, auth = false) => {
  // ':param' se traduce a un grupo con nombre; el resto de la ruta es literal.
  const pattern = new RegExp(
    '^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$',
  );
  routes.push({ method, pattern, handler, auth });
};

const ESTADOS = ['pendiente', 'confirmada', 'cancelada', 'atendida'];

// ---------------------------------------------------------------- publico ---

on('GET', '/api/config', (ctx) => json(ctx.res, 200, {
  parish: config.parishName,
  timezone: config.timezone,
  services: SERVICES,
  min_lead_hours: config.minLeadHours,
  max_days_ahead: config.maxDaysAhead,
  today: localParts().date,
}));

on('GET', '/api/leaders', (ctx) => {
  const leaders = db.prepare(`
    SELECT u.id, u.name, u.title, u.bio
      FROM users u
     WHERE u.active = 1 AND u.role IN ('lider','admin')
       AND EXISTS (SELECT 1 FROM availability_rules r WHERE r.leader_id = u.id AND r.active = 1)
     ORDER BY u.name`).all();
  json(ctx.res, 200, { leaders });
});

on('GET', '/api/availability', (ctx) => {
  const leaderId = v.intIn(ctx.query.leader, 'lider', 1, 2 ** 31);
  const from = ctx.query.from ? v.isoDate(ctx.query.from, 'desde') : localParts().date;
  const to = ctx.query.to ? v.isoDate(ctx.query.to, 'hasta') : addDays(from, 30);
  if (to < from) v.bad('El rango de fechas es invalido.');
  if (to > addDays(from, 92)) v.bad('El rango no puede superar 92 dias.');

  const leader = db.prepare('SELECT id, name, title FROM users WHERE id = ? AND active = 1').get(leaderId);
  if (!leader) throw new HttpError(404, 'El lider no esta disponible.');

  // Solo horarios libres: nunca se expone quien tiene una cita.
  json(ctx.res, 200, { leader, slots: slotsForRange(leaderId, from, to) });
});

on('POST', '/api/appointments', (ctx) => {
  const limit = rateLimit(`booking:${ctx.ipHash}`, config.bookingMaxPerHour, 60);
  if (!limit.allowed) throw new HttpError(429, 'Demasiadas solicitudes. Intente mas tarde.');

  const leaderId = v.intIn(ctx.body.leader_id, 'lider', 1, 2 ** 31);
  const date = v.isoDate(ctx.body.date);
  const startTime = v.hhmm(ctx.body.start_time, 'hora');
  const service = v.oneOf(ctx.body.service, 'motivo', SERVICES);
  const name = v.str(ctx.body.requester_name, 'nombre', { min: 3, max: 120 });
  const email = v.email(ctx.body.requester_email);
  const phone = v.phone(ctx.body.requester_phone, 'telefono', false);
  const notes = v.str(ctx.body.notes, 'comentario', { max: 600, required: false });

  const leader = db.prepare("SELECT id, name FROM users WHERE id = ? AND active = 1 AND role IN ('lider','admin')").get(leaderId);
  if (!leader) throw new HttpError(404, 'El lider no esta disponible.');

  const pending = db.prepare(
    "SELECT COUNT(*) AS n FROM appointments WHERE requester_email = ? AND status IN ('pendiente','confirmada') AND date >= ?",
  ).get(email, localParts().date).n;
  if (pending >= config.maxPendingPerEmail) {
    throw new HttpError(429, `Ya tiene ${pending} citas activas. Cancele una antes de solicitar otra.`);
  }

  const slot = findFreeSlot(leaderId, date, startTime);
  if (!slot) throw new HttpError(409, 'Ese horario ya no esta disponible. Elija otro.');

  const code = publicCode();
  try {
    db.prepare(`INSERT INTO appointments
      (public_code, leader_id, date, start_time, end_time, status, service,
       requester_name, requester_email, requester_phone, notes)
      VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?)`)
      .run(code, leaderId, date, startTime, slot.end_time, service, name, email, phone, notes);
  } catch (err) {
    // El indice unico parcial resuelve la carrera entre dos personas que
    // envian el formulario en el mismo segundo: solo una gana.
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'Ese horario acaba de ser tomado. Elija otro.');
    }
    throw err;
  }

  audit(email, 'cita_solicitada', `${code} ${date} ${startTime} lider=${leaderId}`, ctx.ipHash);
  json(ctx.res, 201, {
    code,
    status: 'pendiente',
    leader: leader.name,
    date,
    start_time: startTime,
    end_time: slot.end_time,
    location: slot.location,
    message: 'Su solicitud quedo registrada. Guarde el codigo para consultarla o cancelarla.',
  });
});

/** Consulta publica: exige codigo + correo, para no filtrar datos con solo el codigo. */
on('POST', '/api/appointments/consulta', (ctx) => {
  const limit = rateLimit(`consulta:${ctx.ipHash}`, 20, 60);
  if (!limit.allowed) throw new HttpError(429, 'Demasiadas consultas. Intente mas tarde.');

  const code = v.str(ctx.body.code, 'codigo', { max: 20 }).toUpperCase();
  const email = v.email(ctx.body.email);
  const row = db.prepare(`
    SELECT a.public_code, a.date, a.start_time, a.end_time, a.status, a.service,
           a.requester_name, a.leader_note, u.name AS leader
      FROM appointments a JOIN users u ON u.id = a.leader_id
     WHERE a.public_code = ? AND a.requester_email = ?`).get(code, email);
  if (!row) throw new HttpError(404, 'No encontramos una cita con ese codigo y correo.');
  json(ctx.res, 200, { appointment: row });
});

on('POST', '/api/appointments/cancelar', (ctx) => {
  const limit = rateLimit(`cancelar:${ctx.ipHash}`, 20, 60);
  if (!limit.allowed) throw new HttpError(429, 'Demasiadas solicitudes. Intente mas tarde.');

  const code = v.str(ctx.body.code, 'codigo', { max: 20 }).toUpperCase();
  const email = v.email(ctx.body.email);
  const row = db.prepare(
    "SELECT id, status FROM appointments WHERE public_code = ? AND requester_email = ?",
  ).get(code, email);
  if (!row) throw new HttpError(404, 'No encontramos una cita con ese codigo y correo.');
  if (row.status === 'cancelada') return json(ctx.res, 200, { status: 'cancelada' });
  if (row.status === 'atendida') throw new HttpError(409, 'La cita ya fue atendida.');

  db.prepare("UPDATE appointments SET status = 'cancelada', updated_at = datetime('now') WHERE id = ?").run(row.id);
  audit(email, 'cita_cancelada_por_solicitante', code, ctx.ipHash);
  json(ctx.res, 200, { status: 'cancelada', message: 'Su cita fue cancelada. El horario vuelve a estar disponible.' });
});

// --------------------------------------------------------------- sesiones ---

on('POST', '/api/auth/login', (ctx) => {
  const email = v.email(ctx.body.email);
  const pass = typeof ctx.body.password === 'string' ? ctx.body.password : '';

  // Doble limite: por IP y por cuenta, para frenar fuerza bruta distribuida.
  const byIp = rateLimit(`login-ip:${ctx.ipHash}`, config.loginMaxAttempts * 3, config.loginWindowMinutes);
  const byUser = rateLimit(`login-user:${email}`, config.loginMaxAttempts, config.loginWindowMinutes);
  if (!byIp.allowed || !byUser.allowed) {
    audit(email, 'login_bloqueado_por_limite', '', ctx.ipHash);
    throw new HttpError(429, 'Demasiados intentos. Espere unos minutos.');
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = user && user.active === 1 && verifyPassword(pass, user.password_hash);
  if (!ok) {
    if (user) {
      db.prepare('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?').run(user.id);
    }
    audit(email, 'login_fallido', '', ctx.ipHash);
    // Mensaje generico: no revela si el correo existe.
    throw new HttpError(401, 'Correo o contrasena incorrectos.');
  }

  db.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').run(user.id);
  // Sesion nueva en cada login: evita fijacion de sesion.
  const { token, csrf } = createSession(user.id);
  audit(email, 'login_exitoso', '', ctx.ipHash);
  json(ctx.res, 200, {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, must_change_password: !!user.must_change_password },
    csrf,
  }, { 'Set-Cookie': sessionCookie(token, config.sessionHours * 3600) });
});

on('POST', '/api/auth/logout', (ctx) => {
  destroySession(ctx.cookies.sid);
  audit(ctx.session.email, 'logout', '', ctx.ipHash);
  json(ctx.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}, 'lider');

on('GET', '/api/auth/me', (ctx) => {
  const user = db.prepare('SELECT id, name, email, role, title, bio, must_change_password FROM users WHERE id = ?')
    .get(ctx.session.user_id);
  json(ctx.res, 200, { user, csrf: ctx.session.csrf_token });
}, 'lider');

on('POST', '/api/auth/password', (ctx) => {
  const current = typeof ctx.body.current_password === 'string' ? ctx.body.current_password : '';
  const next = v.password(ctx.body.new_password);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.session.user_id);
  if (!verifyPassword(current, user.password_hash)) {
    throw new HttpError(401, 'La contrasena actual no es correcta.');
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(hashPassword(next), user.id);
  // Al cambiar la clave se cierran las demas sesiones de esa cuenta.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
    .run(user.id, sha256(ctx.cookies.sid || ''));
  audit(user.email, 'cambio_password', '', ctx.ipHash);
  json(ctx.res, 200, { ok: true });
}, 'lider');

// ------------------------------------------------------------------ panel ---

const targetLeader = (ctx, raw) => {
  // Un lider solo administra su propia agenda; el admin puede ver cualquiera.
  if (raw === undefined || raw === '') return ctx.session.user_id;
  const id = v.intIn(raw, 'lider', 1, 2 ** 31);
  if (id !== ctx.session.user_id && ctx.session.role !== 'admin') {
    throw new HttpError(403, 'Solo puede administrar su propia agenda.');
  }
  return id;
};

on('GET', '/api/panel/appointments', (ctx) => {
  const leaderId = targetLeader(ctx, ctx.query.leader);
  const from = ctx.query.from ? v.isoDate(ctx.query.from, 'desde') : localParts().date;
  const to = ctx.query.to ? v.isoDate(ctx.query.to, 'hasta') : addDays(from, 60);
  const status = ctx.query.status ? v.oneOf(ctx.query.status, 'estado', ESTADOS) : null;

  const rows = db.prepare(`
    SELECT id, public_code, date, start_time, end_time, status, service,
           requester_name, requester_email, requester_phone, notes, leader_note
      FROM appointments
     WHERE leader_id = ? AND date BETWEEN ? AND ? AND (? IS NULL OR status = ?)
     ORDER BY date, start_time`).all(leaderId, from, to, status, status);
  json(ctx.res, 200, { appointments: rows });
}, 'lider');

on('GET', '/api/panel/agenda', (ctx) => {
  const leaderId = targetLeader(ctx, ctx.query.leader);
  const from = ctx.query.from ? v.isoDate(ctx.query.from, 'desde') : localParts().date;
  const to = ctx.query.to ? v.isoDate(ctx.query.to, 'hasta') : addDays(from, 30);
  const slots = slotsForRange(leaderId, from, to, { includeTaken: true });
  const byKey = new Map(
    db.prepare(`SELECT date, start_time, public_code, status, requester_name, service
                  FROM appointments
                 WHERE leader_id = ? AND date BETWEEN ? AND ? AND status IN ('pendiente','confirmada')`)
      .all(leaderId, from, to)
      .map((r) => [stamp(r.date, r.start_time), r]),
  );
  json(ctx.res, 200, {
    slots: slots.map((s) => ({ ...s, appointment: byKey.get(stamp(s.date, s.start_time)) || null })),
  });
}, 'lider');

on('POST', '/api/panel/appointments/:id/estado', (ctx) => {
  const id = v.intIn(ctx.params.id, 'cita', 1, 2 ** 31);
  const status = v.oneOf(ctx.body.status, 'estado', ESTADOS);
  const note = v.str(ctx.body.leader_note, 'nota', { max: 400, required: false });

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!appt) throw new HttpError(404, 'La cita no existe.');
  if (appt.leader_id !== ctx.session.user_id && ctx.session.role !== 'admin') {
    throw new HttpError(403, 'Esta cita no pertenece a su agenda.');
  }
  db.prepare("UPDATE appointments SET status = ?, leader_note = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, note, id);
  audit(ctx.session.email, 'cita_actualizada', `${appt.public_code} -> ${status}`, ctx.ipHash);
  json(ctx.res, 200, { ok: true, status });
}, 'lider');

on('GET', '/api/panel/rules', (ctx) => {
  const leaderId = targetLeader(ctx, ctx.query.leader);
  const rules = db.prepare(
    'SELECT id, weekday, start_time, end_time, slot_minutes, location, active FROM availability_rules WHERE leader_id = ? ORDER BY weekday, start_time',
  ).all(leaderId);
  json(ctx.res, 200, { rules, day_names: DAY_NAMES });
}, 'lider');

on('POST', '/api/panel/rules', (ctx) => {
  const leaderId = targetLeader(ctx, ctx.body.leader_id);
  const weekday = v.intIn(ctx.body.weekday, 'dia', 0, 6);
  const start = v.hhmm(ctx.body.start_time, 'hora de inicio');
  const end = v.hhmm(ctx.body.end_time, 'hora de fin');
  const slotMinutes = v.intIn(ctx.body.slot_minutes, 'duracion', 10, 240);
  const location = v.str(ctx.body.location, 'lugar', { max: 120, required: false });
  if (end <= start) v.bad('La hora de fin debe ser posterior a la de inicio.');

  const info = db.prepare(
    'INSERT INTO availability_rules (leader_id, weekday, start_time, end_time, slot_minutes, location) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(leaderId, weekday, start, end, slotMinutes, location);
  audit(ctx.session.email, 'franja_creada', `${DAY_NAMES[weekday]} ${start}-${end}`, ctx.ipHash);
  json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
}, 'lider');

on('DELETE', '/api/panel/rules/:id', (ctx) => {
  const id = v.intIn(ctx.params.id, 'franja', 1, 2 ** 31);
  const rule = db.prepare('SELECT * FROM availability_rules WHERE id = ?').get(id);
  if (!rule) throw new HttpError(404, 'La franja no existe.');
  if (rule.leader_id !== ctx.session.user_id && ctx.session.role !== 'admin') {
    throw new HttpError(403, 'Esa franja no le pertenece.');
  }
  db.prepare('DELETE FROM availability_rules WHERE id = ?').run(id);
  audit(ctx.session.email, 'franja_eliminada', `${DAY_NAMES[rule.weekday]} ${rule.start_time}`, ctx.ipHash);
  json(ctx.res, 200, { ok: true });
}, 'lider');

on('GET', '/api/panel/blocks', (ctx) => {
  const leaderId = targetLeader(ctx, ctx.query.leader);
  const blocks = db.prepare(
    "SELECT id, date_from, date_to, start_time, end_time, reason FROM blocks WHERE leader_id = ? AND date_to >= date('now','-30 days') ORDER BY date_from",
  ).all(leaderId);
  json(ctx.res, 200, { blocks });
}, 'lider');

on('POST', '/api/panel/blocks', (ctx) => {
  const leaderId = targetLeader(ctx, ctx.body.leader_id);
  const from = v.isoDate(ctx.body.date_from, 'desde');
  const to = v.isoDate(ctx.body.date_to, 'hasta');
  if (to < from) v.bad('El rango de fechas es invalido.');
  const allDay = ctx.body.all_day !== false;
  const start = allDay ? null : v.hhmm(ctx.body.start_time, 'hora de inicio');
  const end = allDay ? null : v.hhmm(ctx.body.end_time, 'hora de fin');
  if (!allDay && end <= start) v.bad('La hora de fin debe ser posterior a la de inicio.');
  const reason = v.str(ctx.body.reason, 'motivo', { max: 160, required: false });

  const info = db.prepare(
    'INSERT INTO blocks (leader_id, date_from, date_to, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(leaderId, from, to, start, end, reason);
  audit(ctx.session.email, 'bloqueo_creado', `${from}..${to} ${reason}`, ctx.ipHash);
  json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
}, 'lider');

on('DELETE', '/api/panel/blocks/:id', (ctx) => {
  const id = v.intIn(ctx.params.id, 'bloqueo', 1, 2 ** 31);
  const block = db.prepare('SELECT * FROM blocks WHERE id = ?').get(id);
  if (!block) throw new HttpError(404, 'El bloqueo no existe.');
  if (block.leader_id !== ctx.session.user_id && ctx.session.role !== 'admin') {
    throw new HttpError(403, 'Ese bloqueo no le pertenece.');
  }
  db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
  audit(ctx.session.email, 'bloqueo_eliminado', `${block.date_from}..${block.date_to}`, ctx.ipHash);
  json(ctx.res, 200, { ok: true });
}, 'lider');

on('POST', '/api/panel/perfil', (ctx) => {
  const title = v.str(ctx.body.title, 'cargo', { max: 80, required: false });
  const bio = v.str(ctx.body.bio, 'presentacion', { max: 400, required: false });
  db.prepare('UPDATE users SET title = ?, bio = ? WHERE id = ?').run(title, bio, ctx.session.user_id);
  json(ctx.res, 200, { ok: true });
}, 'lider');

// ------------------------------------------------------------ administrador ---

on('GET', '/api/admin/users', (ctx) => {
  const users = db.prepare(
    'SELECT id, name, email, role, title, active, created_at FROM users ORDER BY role, name',
  ).all();
  json(ctx.res, 200, { users });
}, 'admin');

on('POST', '/api/admin/users', (ctx) => {
  const name = v.str(ctx.body.name, 'nombre', { min: 3, max: 120 });
  const email = v.email(ctx.body.email);
  const role = v.oneOf(ctx.body.role || 'lider', 'rol', ['lider', 'admin']);
  const title = v.str(ctx.body.title, 'cargo', { max: 80, required: false });
  const pass = v.password(ctx.body.password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
  }
  const info = db.prepare(
    'INSERT INTO users (name, email, role, title, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
  ).run(name, email, role, title, hashPassword(pass));
  audit(ctx.session.email, 'usuario_creado', `${email} (${role})`, ctx.ipHash);
  json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
}, 'admin');

on('POST', '/api/admin/users/:id/estado', (ctx) => {
  const id = v.intIn(ctx.params.id, 'usuario', 1, 2 ** 31);
  const active = ctx.body.active === true ? 1 : 0;
  if (id === ctx.session.user_id && active === 0) {
    throw new HttpError(400, 'No puede desactivar su propia cuenta.');
  }
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(id);
  if (!user) throw new HttpError(404, 'El usuario no existe.');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // corta el acceso ya
  audit(ctx.session.email, active ? 'usuario_activado' : 'usuario_desactivado', user.email, ctx.ipHash);
  json(ctx.res, 200, { ok: true });
}, 'admin');

on('POST', '/api/admin/users/:id/password', (ctx) => {
  const id = v.intIn(ctx.params.id, 'usuario', 1, 2 ** 31);
  const pass = v.password(ctx.body.password);
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(id);
  if (!user) throw new HttpError(404, 'El usuario no existe.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0 WHERE id = ?')
    .run(hashPassword(pass), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(ctx.session.email, 'password_restablecida', user.email, ctx.ipHash);
  json(ctx.res, 200, { ok: true });
}, 'admin');

on('GET', '/api/admin/audit', (ctx) => {
  const rows = db.prepare('SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 200').all();
  json(ctx.res, 200, { entries: rows });
}, 'admin');

export { routes };
