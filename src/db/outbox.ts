import { db } from './index.js'

export const MAX_ATTEMPTS = 6

export type OutboxRow = {
  id: number
  event_id: number
  target_jid: string
  body: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  next_attempt_at: string
  last_error: string | null
  sent_at: string | null
  created_at: string
}

const enqueueStmt = db.prepare(`
  INSERT INTO outbox (event_id, target_jid, body, next_attempt_at, created_at)
  VALUES (?, ?, ?, ?, ?)
`)

const claimPendingStmt = db.prepare(`
  SELECT * FROM outbox
  WHERE status = 'pending' AND next_attempt_at <= ?
  ORDER BY id ASC
  LIMIT ?
`)

const markSentStmt = db.prepare(`
  UPDATE outbox
  SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL
  WHERE id = ?
`)

const markRetryStmt = db.prepare(`
  UPDATE outbox
  SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
  WHERE id = ?
`)

const markFailedStmt = db.prepare(`
  UPDATE outbox
  SET status = 'failed', attempts = attempts + 1, last_error = ?
  WHERE id = ?
`)

export function enqueue(input: {
  eventId: number
  targetJid: string
  body: string
}): number {
  const now = new Date().toISOString()
  const result = enqueueStmt.run(
    input.eventId,
    input.targetJid,
    input.body,
    now, // elegível imediatamente
    now,
  )
  return Number(result.lastInsertRowid)
}

const hasForEventStmt = db.prepare(`SELECT 1 FROM outbox WHERE event_id = ? LIMIT 1`)

/** True se o evento já gerou alguma mensagem (enviada, pendente ou falha). */
export function hasMessageForEvent(eventId: number): boolean {
  return hasForEventStmt.get(eventId) !== undefined
}

export function claimPending(limit = 10): OutboxRow[] {
  return claimPendingStmt.all(new Date().toISOString(), limit) as OutboxRow[]
}

export function markSent(id: number) {
  markSentStmt.run(new Date().toISOString(), id)
}

/**
 * Registra a falha. Enquanto houver tentativas sobrando, reagenda com backoff
 * exponencial (5s, 15s, 45s, 135s...); esgotadas, marca como `failed`.
 */
export function markFailure(row: OutboxRow, error: string) {
  const attempts = row.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    markFailedStmt.run(error, row.id)
    return { retrying: false as const, attempts }
  }

  const delayMs = 5_000 * 3 ** row.attempts
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString()
  markRetryStmt.run(nextAttemptAt, error, row.id)
  return { retrying: true as const, attempts, nextAttemptAt }
}

const countPendingStmt = db.prepare(`SELECT COUNT(*) as n FROM outbox WHERE status = 'pending'`)

/** Quantas mensagens ainda esperam envio — usado só para log de diagnóstico. */
export function countPending(): number {
  return (countPendingStmt.get() as { n: number }).n
}

export function stats() {
  return db
    .prepare(`SELECT status, COUNT(*) as count FROM outbox GROUP BY status`)
    .all() as { status: string; count: number }[]
}
