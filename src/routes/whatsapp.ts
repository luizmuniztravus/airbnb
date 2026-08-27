import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'
import { getQr, getStatus, isConnected } from '../whatsapp/client.js'
import { listGroups, sendText, NotConnectedError } from '../whatsapp/sender.js'
import { listRecentEvents } from '../db/events.js'
import { requireToken } from './auth.js'

export async function whatsappRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireToken)

  app.get('/whatsapp/status', async () => ({
    status: getStatus(),
    connected: isConnected(),
    groupJid: env.WHATSAPP_GROUP_JID ?? null,
    // String bruta do QR: gere a imagem em qualquer leitor
    // (ex.: https://api.qrserver.com) quando não houver acesso ao terminal.
    qr: getQr() ?? null,
  }))

  app.get('/whatsapp/groups', async (_req, reply) => {
    try {
      return { groups: await listGroups() }
    } catch (err) {
      if (err instanceof NotConnectedError) {
        return reply.code(503).send({ error: 'not_connected', status: getStatus() })
      }
      throw err
    }
  })

  app.post('/whatsapp/test', async (_req, reply) => {
    if (!env.WHATSAPP_GROUP_JID) {
      return reply.code(400).send({
        error: 'group_not_configured',
        hint: 'defina WHATSAPP_GROUP_JID (veja GET /whatsapp/groups)',
      })
    }
    try {
      const messageId = await sendText(
        env.WHATSAPP_GROUP_JID,
        `🔧 Teste do notificador de check-in — ${new Date().toLocaleString('pt-BR')}`,
      )
      return { status: 'sent', messageId }
    } catch (err) {
      if (err instanceof NotConnectedError) {
        return reply.code(503).send({ error: 'not_connected', status: getStatus() })
      }
      throw err
    }
  })

  // Payloads já recebidos — a base para mapear os campos reais em domain/checkin.ts.
  app.get('/events', async (req) => {
    const limit = Number((req.query as { limit?: string })?.limit ?? 20)
    return {
      events: listRecentEvents(Number.isFinite(limit) ? Math.min(limit, 100) : 20).map((e) => ({
        id: e.id,
        source: e.source,
        dedupeKey: e.dedupe_key,
        receivedAt: e.received_at,
        payload: JSON.parse(e.raw_payload) as unknown,
      })),
    }
  })
}
