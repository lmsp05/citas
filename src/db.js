import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);

// WAL mejora la concurrencia lectura/escritura; FULL sync evita perder
// commits ante un corte de energia (importante: la agenda es el negocio).
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'lider')),
  password_hash TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Disponibilidad recurrente semanal de cada lider.
CREATE TABLE IF NOT EXISTS availability_rules (
  id           INTEGER PRIMARY KEY,
  leader_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = domingo
  start_time   TEXT NOT NULL,   -- 'HH:MM' hora local de la parroquia
  end_time     TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL CHECK (slot_minutes BETWEEN 10 AND 240),
  location     TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rules_leader ON availability_rules(leader_id, weekday);

-- Bloqueos puntuales (retiros, vacaciones, funerales, etc.).
CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY,
  leader_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date_from  TEXT NOT NULL,          -- 'YYYY-MM-DD'
  date_to    TEXT NOT NULL,
  start_time TEXT,                   -- NULL = dia completo
  end_time   TEXT,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blocks_leader ON blocks(leader_id, date_from, date_to);

CREATE TABLE IF NOT EXISTS appointments (
  id             INTEGER PRIMARY KEY,
  public_code    TEXT NOT NULL UNIQUE,
  leader_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  date           TEXT NOT NULL,      -- 'YYYY-MM-DD'
  start_time     TEXT NOT NULL,      -- 'HH:MM'
  end_time       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pendiente','confirmada','cancelada','atendida')),
  service        TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  requester_phone TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  leader_note    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Garantia dura contra doble reserva: una sola cita viva por lider y horario.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_slot
  ON appointments(leader_id, date, start_time)
  WHERE status IN ('pendiente', 'confirmada');
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date, leader_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  ip_hash    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
`);

export function audit(actor, action, detail = '', ipHash = '') {
  db.prepare('INSERT INTO audit_log (actor, action, detail, ip_hash) VALUES (?, ?, ?, ?)')
    .run(String(actor), action, String(detail).slice(0, 500), ipHash);
}
