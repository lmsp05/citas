/**
 * Crea datos iniciales de ejemplo (parroco, vicario, agente pastoral) con
 * franjas de atencion. Ejecutar una sola vez: node src/seed.js
 *
 * Las contrasenas se toman de variables de entorno si existen; si no, se
 * generan al azar y se imprimen UNA vez en consola para copiarlas.
 */
import { db, audit } from './db.js';
import { hashPassword, randomToken } from './security.js';

const demo = [
  {
    name: 'Pbro. Andres Gomez', email: 'parroco@parroquia.org', role: 'admin',
    title: 'Parroco', bio: 'Atiende confesiones, direccion espiritual y preparacion de sacramentos.',
    rules: [
      { weekday: 2, start: '09:00', end: '12:00', mins: 30, location: 'Despacho parroquial' },
      { weekday: 4, start: '15:00', end: '18:00', mins: 30, location: 'Despacho parroquial' },
      { weekday: 6, start: '09:00', end: '11:00', mins: 20, location: 'Confesionario' },
    ],
  },
  {
    name: 'Pbro. Luis Fernando Rivas', email: 'vicario@parroquia.org', role: 'lider',
    title: 'Vicario parroquial', bio: 'Acompanamiento a jovenes y preparacion matrimonial.',
    rules: [
      { weekday: 1, start: '16:00', end: '19:00', mins: 45, location: 'Salon San Juan' },
      { weekday: 3, start: '16:00', end: '19:00', mins: 45, location: 'Salon San Juan' },
    ],
  },
  {
    name: 'Hna. Marta Ocampo', email: 'pastoral@parroquia.org', role: 'lider',
    title: 'Coordinadora de pastoral social', bio: 'Visitas a enfermos y acompanamiento en duelo.',
    rules: [
      { weekday: 3, start: '08:00', end: '11:00', mins: 30, location: 'Casa cural' },
      { weekday: 5, start: '14:00', end: '17:00', mins: 30, location: 'Casa cural' },
    ],
  },
];

for (const person of demo) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(person.email);
  if (existing) {
    console.log(`- ${person.email} ya existe, se omite.`);
    continue;
  }
  const envKey = `SEED_PASSWORD_${person.role.toUpperCase()}`;
  const password = process.env[envKey] || `${randomToken(9)}A1`;
  const info = db.prepare(
    'INSERT INTO users (name, email, role, title, bio, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)',
  ).run(person.name, person.email, person.role, person.title, person.bio, hashPassword(password));

  for (const r of person.rules) {
    db.prepare(
      'INSERT INTO availability_rules (leader_id, weekday, start_time, end_time, slot_minutes, location) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(Number(info.lastInsertRowid), r.weekday, r.start, r.end, r.mins, r.location);
  }
  audit('seed', 'usuario_creado', person.email);
  console.log(`+ ${person.role.padEnd(5)} ${person.email}  contrasena: ${password}`);
}

console.log('\nGuarde estas contrasenas en un gestor y cambielas en el primer ingreso.');
db.close();
