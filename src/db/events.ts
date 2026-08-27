import { db } from './index.js'

export type EventRow = {
  id: number
  dedupe_key: string
  source: string
  raw_payload: string
  received_at: string
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO events (dedupe_key, source, raw_payload, received_at)
  VALUES (@dedupe_key, @source, @raw_payload, @received_at)
`)

const findByKeyStmt = db.prepare(`SELECT * FROM events WHERE dedupe_key = ?`)

/**
 * Insere o evento. Se `dedupeKey` já existir, nada é inserido e
 * `isDuplicate` volta true — o webhook então não reenfileira a mensagem.
 */
export function insertEvent(input: {
  dedupeKey: string
  source: string
  rawPayload: string
}): { id: number; isDuplicate: boolean } {
  const result = insertStmt.run({
    dedupe_key: input.dedupeKey,
    source: input.source,
    raw_payload: input.rawPayload,
    received_at: new Date().toISOString(),
  })

  if (result.changes === 1) {
    return { id: Number(result.lastInsertRowid), isDuplicate: false }
  }

  const existing = findByKeyStmt.get(input.dedupeKey) as EventRow | undefined
  return { id: existing?.id ?? -1, isDuplicate: true }
}

/** Últimos payloads recebidos — base para mapear os campos reais depois. */
export function listRecentEvents(limit = 20): EventRow[] {
  return db
    .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
    .all(limit) as EventRow[]
}
