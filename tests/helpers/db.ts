import './setup.js'
import { db } from '../../src/db/index.js'
import type { OutboxRow } from '../../src/db/outbox.js'
import type { EventRow } from '../../src/db/events.js'

export { db }

/** Zera as tabelas entre testes. `outbox` primeiro: tem FK para `events`. */
export function resetDb(): void {
  db.exec('DELETE FROM outbox; DELETE FROM events;')
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('outbox', 'events')`)
}

/** Cria um evento direto no banco, para testes que só precisam do id. */
export function seedEvent(dedupeKey = `evt-${Math.random()}`): number {
  const result = db
    .prepare(
      `INSERT INTO events (dedupe_key, source, raw_payload, received_at)
       VALUES (?, 'teste', '{}', ?)`,
    )
    .run(dedupeKey, new Date().toISOString())
  return Number(result.lastInsertRowid)
}

export function getOutboxRow(id: number): OutboxRow {
  const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined
  if (!row) throw new Error(`outbox ${id} não encontrado`)
  return row
}

export function getEventRow(id: number): EventRow {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined
  if (!row) throw new Error(`event ${id} não encontrado`)
  return row
}

/** Força `next_attempt_at` — evita esperar o backoff real no teste. */
export function setNextAttempt(id: number, at: Date): void {
  db.prepare('UPDATE outbox SET next_attempt_at = ? WHERE id = ?').run(at.toISOString(), id)
}
