import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// La base de datos de pruebas es temporal y NODE_ENV=test evita que el
// servidor se ponga a escuchar solo al importarlo.
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'citas-test-')), 'test.db');
process.env.MIN_LEAD_HOURS = '0';
process.env.SECURE_COOKIES = 'false';

const { db } = await import('../src/db.js');
const { hashPassword, verifyPassword, publicCode } = await import('../src/security.js');
const { slotsForRange } = await import('../src/slots.js');
const { addDays, localParts, weekdayOf } = await import('../src/time.js');
const { server } = await import('../src/server.js');

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); db.close(); });

const ADMIN_PASS = 'ClaveSegura2026';
const leaderId = Number(db.prepare(
  "INSERT INTO users (name, email, role, title, password_hash) VALUES ('Padre Prueba','padre@test.org','admin','Parroco',?)",
).run(hashPassword(ADMIN_PASS)).lastInsertRowid);

// Franja para el dia siguiente, con citas de 30 minutos.
const target = addDays(localParts().date, 1);
db.prepare(
  'INSERT INTO availability_rules (leader_id, weekday, start_time, end_time, slot_minutes, location) VALUES (?, ?, ?, ?, ?, ?)',
).run(leaderId, weekdayOf(target), '09:00', '11:00', 30, 'Despacho');

const call = (path, options = {}) => fetch(base + path, {
  ...options,
  headers: {
    'Content-Type': 'application/json',
    Origin: base, // el servidor exige origen propio en operaciones de escritura
    ...(options.headers || {}),
  },
});

const solicitar = (overrides = {}) => call('/api/appointments', {
  method: 'POST',
  body: JSON.stringify({
    leader_id: leaderId,
    date: target,
    start_time: '09:00',
    service: 'Confesion',
    requester_name: 'Maria Perez',
    requester_email: 'maria@ejemplo.com',
    ...overrides,
  }),
});

test('la disponibilidad se calcula a partir de las franjas', () => {
  const slots = slotsForRange(leaderId, target, target);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((s) => s.start_time), ['09:00', '09:30', '10:00', '10:30']);
});

test('un bloqueo de dia completo elimina la disponibilidad', () => {
  const id = Number(db.prepare(
    "INSERT INTO blocks (leader_id, date_from, date_to, reason) VALUES (?, ?, ?, 'Retiro')",
  ).run(leaderId, target, target).lastInsertRowid);
  assert.equal(slotsForRange(leaderId, target, target).length, 0);
  db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
  assert.equal(slotsForRange(leaderId, target, target).length, 4);
});

test('el hash de contrasena no guarda el texto plano y verifica correctamente', () => {
  const hash = hashPassword('unaClaveLarga123');
  assert.ok(!hash.includes('unaClaveLarga123'));
  assert.ok(verifyPassword('unaClaveLarga123', hash));
  assert.ok(!verifyPassword('otraClave123', hash));
});

test('el codigo publico no es predecible ni ambiguo', () => {
  const codes = new Set(Array.from({ length: 200 }, () => publicCode()));
  assert.equal(codes.size, 200);
  assert.match([...codes][0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('se puede solicitar una cita y el horario deja de ofrecerse', async () => {
  const res = await solicitar();
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.status, 'pendiente');

  const disponibles = await (await call(`/api/availability?leader=${leaderId}&from=${target}&to=${target}`)).json();
  assert.ok(!disponibles.slots.some((s) => s.start_time === '09:00'));
});

test('el mismo horario no se puede reservar dos veces', async () => {
  const res = await solicitar({ requester_email: 'otro@ejemplo.com', requester_name: 'Juan Ruiz' });
  assert.equal(res.status, 409);
});

test('se rechazan datos invalidos con 400', async () => {
  const res = await solicitar({ start_time: '09:30', requester_email: 'no-es-correo' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /correo/i);
});

test('no se aceptan escrituras desde otro origen (CSRF)', async () => {
  const res = await fetch(`${base}/api/appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://sitio-malicioso.example' },
    body: JSON.stringify({ leader_id: leaderId, date: target, start_time: '10:00' }),
  });
  assert.equal(res.status, 403);
});

test('el panel exige sesion', async () => {
  assert.equal((await call('/api/panel/appointments')).status, 401);
});

test('la consulta publica exige codigo y correo coincidentes', async () => {
  const codigo = db.prepare('SELECT public_code FROM appointments LIMIT 1').get().public_code;
  const malo = await call('/api/appointments/consulta', {
    method: 'POST',
    body: JSON.stringify({ code: codigo, email: 'intruso@ejemplo.com' }),
  });
  assert.equal(malo.status, 404);

  const bueno = await call('/api/appointments/consulta', {
    method: 'POST',
    body: JSON.stringify({ code: codigo, email: 'maria@ejemplo.com' }),
  });
  assert.equal(bueno.status, 200);
  assert.equal((await bueno.json()).appointment.status, 'pendiente');
});

test('flujo de lider: login, confirmar cita y liberar horario al cancelar', async () => {
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'padre@test.org', password: ADMIN_PASS }),
  });
  assert.equal(login.status, 200);
  const { csrf } = await login.json();
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  assert.match(login.headers.getSetCookie()[0], /HttpOnly/);
  assert.match(login.headers.getSetCookie()[0], /SameSite=Strict/);

  const auth = { Cookie: cookie, 'X-CSRF-Token': csrf };
  const lista = await (await call('/api/panel/appointments?status=pendiente', { headers: auth })).json();
  assert.equal(lista.appointments.length, 1);
  const cita = lista.appointments[0];

  // Sin el token CSRF la escritura autenticada se rechaza.
  const sinToken = await call(`/api/panel/appointments/${cita.id}/estado`, {
    method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ status: 'confirmada' }),
  });
  assert.equal(sinToken.status, 403);

  const confirmar = await call(`/api/panel/appointments/${cita.id}/estado`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'confirmada' }),
  });
  assert.equal(confirmar.status, 200);

  const cancelar = await call(`/api/panel/appointments/${cita.id}/estado`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'cancelada', leader_note: 'Reprogramar' }),
  });
  assert.equal(cancelar.status, 200);

  const disponibles = await (await call(`/api/availability?leader=${leaderId}&from=${target}&to=${target}`)).json();
  assert.ok(disponibles.slots.some((s) => s.start_time === '09:00'), 'el horario debe volver a estar libre');
});

test('un lider no puede tocar la agenda de otro', async () => {
  const otroId = Number(db.prepare(
    "INSERT INTO users (name, email, role, password_hash) VALUES ('Otro Lider','otro@test.org','lider',?)",
  ).run(hashPassword('ClaveSegura2026')).lastInsertRowid);
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'otro@test.org', password: 'ClaveSegura2026' }),
  });
  const { csrf } = await login.json();
  const auth = { Cookie: login.headers.getSetCookie()[0].split(';')[0], 'X-CSRF-Token': csrf };

  assert.equal((await call(`/api/panel/appointments?leader=${leaderId}`, { headers: auth })).status, 403);
  assert.equal((await call('/api/admin/users', { headers: auth })).status, 403);
  db.prepare('DELETE FROM users WHERE id = ?').run(otroId);
});

test('el login bloquea la fuerza bruta', async () => {
  let ultimo;
  for (let i = 0; i < 8; i++) {
    ultimo = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'padre@test.org', password: 'incorrecta123' }),
    });
  }
  assert.equal(ultimo.status, 429);
});

test('no se sirven archivos fuera de public/', async () => {
  const res = await fetch(`${base}/../src/db.js`);
  assert.ok([403, 404].includes(res.status));
});

test('las respuestas llevan cabeceras de seguridad', async () => {
  const res = await call('/api/config');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});
