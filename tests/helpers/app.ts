import './setup.js'
import Fastify, { type FastifyInstance } from 'fastify'
import { webhookRoutes } from '../../src/routes/webhook.js'
import { requireToken } from '../../src/routes/auth.js'

/**
 * Monta só as rotas sob teste, sem `buildServer()`: assim os testes de HTTP não
 * arrastam `whatsapp/client.ts` (e o Baileys inteiro) para dentro do processo.
 */
export async function buildWebhookApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(webhookRoutes)
  await app.ready()
  return app
}

/** App mínimo com uma rota protegida, para exercitar `requireToken` isolado. */
export async function buildProtectedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.get('/protegida', { preHandler: requireToken }, async () => ({ ok: true }))
  await app.ready()
  return app
}
