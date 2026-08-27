import { claimPending, countPending, markFailure, markSent, MAX_ATTEMPTS } from '../db/outbox.js'
import { getStatus, isConnected } from './client.js'
import { sendText } from './sender.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'outbox' })

const TICK_MS = 5_000
const BATCH_SIZE = 10

// Um aviso a cada ~1 min enquanto o WhatsApp está fora do ar. A cada tick (5s)
// inundaria o log do pm2 e esconderia o resto.
const OFFLINE_WARN_TICKS = 12

let timer: NodeJS.Timeout | undefined
let running = false
let offlineTicks = 0
let offlineSince: number | undefined

/**
 * Loga a fila parada de tempos em tempos. Sem isto, uma desconexão longa é
 * silenciosa: o worker apenas pula o ciclo e nada aparece em `pm2 logs`.
 */
function reportarDesconexao() {
  offlineSince ??= Date.now()
  offlineTicks += 1
  if (offlineTicks % OFFLINE_WARN_TICKS !== 0) return

  const pending = countPending()
  if (pending === 0) return

  log.warn(
    { pending, whatsapp: getStatus(), offlineMs: Date.now() - offlineSince },
    'WhatsApp desconectado — mensagens seguram na fila',
  )
}

function reportarReconexao() {
  if (offlineSince === undefined) return
  const pending = countPending()
  if (pending > 0 || offlineTicks >= OFFLINE_WARN_TICKS) {
    log.info({ pending, offlineMs: Date.now() - offlineSince }, 'conexão de volta — retomando fila')
  }
  offlineTicks = 0
  offlineSince = undefined
}

async function tick() {
  // Reentrância: um envio lento não pode sobrepor o próximo tick.
  if (running) return
  // Sem conexão não adianta tentar — o item continua pending e não gasta tentativa.
  if (!isConnected()) {
    reportarDesconexao()
    return
  }
  reportarReconexao()

  running = true
  try {
    const pending = claimPending(BATCH_SIZE)
    let enviadas = 0

    for (const row of pending) {
      try {
        const messageId = await sendText(row.target_jid, row.body)
        markSent(row.id)
        enviadas += 1
        log.info(
          { outboxId: row.id, eventId: row.event_id, messageId, jid: row.target_jid },
          'mensagem enviada',
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const outcome = markFailure(row, message)
        if (outcome.retrying) {
          log.warn(
            { outboxId: row.id, eventId: row.event_id, attempts: outcome.attempts, max: MAX_ATTEMPTS, nextAttemptAt: outcome.nextAttemptAt, err: message },
            'falha no envio, reagendado',
          )
        } else {
          // Fim da linha: ninguém mais tenta esta mensagem. Precisa de olho humano.
          log.error(
            { outboxId: row.id, eventId: row.event_id, attempts: outcome.attempts, max: MAX_ATTEMPTS, err: message },
            'falha definitiva no envio — mensagem NÃO será entregue',
          )
        }
        // Se a conexão caiu no meio do lote, para agora e retoma no próximo tick.
        if (!isConnected()) {
          log.warn(
            { restante: pending.length - enviadas },
            'conexão caiu no meio do lote — retomando no próximo ciclo',
          )
          break
        }
      }
    }

    // Lote cheio = provavelmente há mais esperando; ajuda a explicar atraso.
    if (pending.length === BATCH_SIZE) {
      log.info({ enviadas, pending: countPending() }, 'lote cheio — ainda há fila')
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
  log.info({ intervalMs: TICK_MS, batchSize: BATCH_SIZE, maxAttempts: MAX_ATTEMPTS }, 'worker do outbox iniciado')
}

export function stopOutboxWorker() {
  if (!timer) return
  clearInterval(timer)
  timer = undefined
  log.info({ pending: countPending() }, 'worker do outbox parado')
}
