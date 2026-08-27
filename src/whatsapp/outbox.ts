import { claimPending, markFailure, markSent, MAX_ATTEMPTS } from '../db/outbox.js'
import { isConnected } from './client.js'
import { sendText } from './sender.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'outbox' })

const TICK_MS = 5_000
const BATCH_SIZE = 10

let timer: NodeJS.Timeout | undefined
let running = false

async function tick() {
  // Reentrância: um envio lento não pode sobrepor o próximo tick.
  if (running) return
  // Sem conexão não adianta tentar — o item continua pending e não gasta tentativa.
  if (!isConnected()) return

  running = true
  try {
    const pending = claimPending(BATCH_SIZE)
    for (const row of pending) {
      try {
        const messageId = await sendText(row.target_jid, row.body)
        markSent(row.id)
        log.info({ outboxId: row.id, eventId: row.event_id, messageId }, 'mensagem enviada')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const outcome = markFailure(row, message)
        if (outcome.retrying) {
          log.warn(
            { outboxId: row.id, attempts: outcome.attempts, nextAttemptAt: outcome.nextAttemptAt, err: message },
            'falha no envio, reagendado',
          )
        } else {
          log.error(
            { outboxId: row.id, attempts: outcome.attempts, max: MAX_ATTEMPTS, err: message },
            'falha definitiva no envio',
          )
        }
        // Se a conexão caiu no meio do lote, para agora e retoma no próximo tick.
        if (!isConnected()) break
      }
    }
  } catch (err) {
    log.error({ err }, 'erro no ciclo do outbox')
  } finally {
    running = false
  }
}

export function startOutboxWorker() {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  log.info({ intervalMs: TICK_MS }, 'worker do outbox iniciado')
}

export function stopOutboxWorker() {
  if (timer) clearInterval(timer)
  timer = undefined
}
