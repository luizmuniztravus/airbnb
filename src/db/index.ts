import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { env } from '../config/env.js'

mkdirSync(dirname(env.DB_PATH), { recursive: true })

export const db = new Database(env.DB_PATH)

// WAL evita que a leitura do worker bloqueie a escrita do webhook.
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key   TEXT UNIQUE,
    source       TEXT NOT NULL,
    raw_payload  TEXT NOT NULL,
    received_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER NOT NULL REFERENCES events(id),
    target_jid      TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    sent_at         TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox(status, next_attempt_at);
`)

export function closeDb() {
  db.close()
}
