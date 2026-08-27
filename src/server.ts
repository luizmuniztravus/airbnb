import Fastify, { type FastifyError } from 'fastify'
import { logger } from './logger.js'
import { healthRoutes } from './routes/health.js'
import { webhookRoutes } from './routes/webhook.js'
import { whatsappRoutes } from './routes/whatsapp.js'

export function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // O provedor do webhook pode mandar o payload sem content-type correto;
    // manter o body cru disponível facilita adicionar validação HMAC depois.
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  })

  // Payload inválido não deve virar 500 nem derrubar o handler.
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    req.log.error({ err }, 'erro na requisição')
    const status = err.statusCode ?? 500
    reply.code(status).send({ error: status === 500 ? 'internal_error' : err.message })
  })

  app.register(healthRoutes)
  app.register(webhookRoutes)
  app.register(whatsappRoutes)

  return app
}
