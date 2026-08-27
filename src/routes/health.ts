import type { FastifyInstance } from 'fastify'
import { getStatus } from '../whatsapp/client.js'
import { stats } from '../db/outbox.js'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok',
    whatsapp: getStatus(),
    outbox: Object.fromEntries(stats().map((s) => [s.status, s.count])),
    uptime: Math.round(process.uptime()),
  }))
}
