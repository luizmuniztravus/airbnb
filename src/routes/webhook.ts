import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'
import { insertEvent } from '../db/events.js'
import { enqueue, hasMessageForEvent } from '../db/outbox.js'
import { normalizeCheckin, isUnmapped } from '../domain/checkin.js'
import { formatCheckinMessage } from '../domain/template.js'
import { requireToken } from './auth.js'

const SOURCE = 'nova-reserva'

/** Campos de id mais comuns; sem nenhum deles, cai no hash do payload. */
const ID_FIELDS = [
  'id',
  'event_id',
  'reservation_id',
  'booking_id',
  // O provedor real (workflow do PMS) manda o id da reserva neste nome. Sem
  // ele a chave caía no SHA-256 do corpo, que inclui `_workflow_execution_id`
  // — valor que muda a cada execução, fazendo um reprocessamento da mesma
  // reserva escapar da deduplicação e duplicar a mensagem no grupo.
  'booking_uuid',
  'confirmation_code',
  'reservation_code',
  'uuid',
]

/**
 * Sufixo de status para a chave de deduplicação.
 *
 * O cancelamento chega com o MESMO id da reserva original. Sem isto, a segunda
 * mensagem seria descartada como duplicata e o grupo nunca saberia do
 * cancelamento. `confirmed` (e a ausência de status) não recebem sufixo, para
 * não invalidar as chaves já gravadas das reservas existentes.
 */
function statusSuffix(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const status = (payload as Record<string, unknown>)['status']
  if (typeof status !== 'string') return ''
  const normalizado = status.trim().toLowerCase()
  if (normalizado === '' || normalizado === 'confirmed') return ''
  return `:${normalizado}`
}

function resolveDedupeKey(payload: unknown, rawJson: string): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const sufixo = statusSuffix(payload)
    for (const field of ID_FIELDS) {
      const value = record[field]
      if (typeof value === 'string' && value.trim() !== '') {
        return `${SOURCE}:${value.trim()}${sufixo}`
      }
      if (typeof value === 'number') return `${SOURCE}:${value}${sufixo}`
    }
  }
  // O hash já cobre o corpo inteiro, status incluso — não precisa de sufixo.
  return `${SOURCE}:sha256:${createHash('sha256').update(rawJson).digest('hex')}`
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post(
    '/webhooks/nova-reserva',
    { preHandler: requireToken },
    async (req, reply) => {
      const payload = req.body ?? {}
      const rawJson = JSON.stringify(payload)

      // Responder rápido é o ponto: o provedor não deve esperar o WhatsApp.
      const dedupeKey = resolveDedupeKey(payload, rawJson)
      const event = insertEvent({ dedupeKey, source: SOURCE, rawPayload: rawJson })

      // Um evento já visto só é ignorado se de fato virou mensagem. Eventos
      // gravados antes do grupo existir (`stored_no_target`) ficariam presos
      // como duplicados para sempre — aqui eles são recuperados no reenvio.
      if (event.isDuplicate && hasMessageForEvent(event.id)) {
        req.log.info({ dedupeKey, eventId: event.id }, 'evento duplicado, ignorado')
        return reply.code(200).send({ status: 'duplicate', eventId: event.id })
      }

      if (!env.WHATSAPP_GROUP_JID) {
        // O evento fica gravado; sem destino não há o que enfileirar.
        req.log.error({ eventId: event.id }, 'WHATSAPP_GROUP_JID não configurado — evento salvo sem envio')
        return reply.code(200).send({
          status: 'stored_no_target',
          eventId: event.id,
          hint: 'configure WHATSAPP_GROUP_JID (veja GET /whatsapp/groups)',
        })
      }

      const evt = normalizeCheckin(payload)
      const body = formatCheckinMessage(evt)
      const outboxId = enqueue({
        eventId: event.id,
        targetJid: env.WHATSAPP_GROUP_JID,
        body,
      })

      // Nenhum campo reconhecido significa mensagem crua no grupo — o sinal de
      // que `domain/checkin.ts` precisa ser ajustado ao payload real.
      if (isUnmapped(evt)) {
        req.log.warn(
          { eventId: event.id, outboxId, dedupeKey, campos: Object.keys(payload as object) },
          'payload sem campos reconhecidos — ajuste normalizeCheckin (veja GET /events)',
        )
      }

      req.log.info(
        { eventId: event.id, outboxId, dedupeKey, bytes: rawJson.length },
        'evento enfileirado',
      )

      return reply.code(200).send({ status: 'queued', eventId: event.id, outboxId })
    },
  )
}
