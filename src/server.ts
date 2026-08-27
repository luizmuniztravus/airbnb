import { randomUUID } from 'node:crypto'
import Fastify, { LogController, type FastifyError } from 'fastify'
import { logger } from './logger.js'
import { healthRoutes } from './routes/health.js'
import { webhookRoutes } from './routes/webhook.js'
import { whatsappRoutes } from './routes/whatsapp.js'

/** `/health` é chamado por monitoramento a cada poucos segundos — não polui o log. */
function isNoisyRoute(url: string): boolean {
  return url === '/health' || url.startsWith('/health?')
}

export function buildServer() {
  const app = Fastify({
    loggerInstance: logger,

    // O log automático do Fastify gera duas linhas por request ("incoming" +
    // "completed") e despeja todos os headers — inclusive o x-webhook-token.
    // Aqui uma linha só, no hook onResponse, com o que interessa.
    // (a opção `disableRequestLogging` solta é deprecada e sai no fastify@6)
    logController: new LogController({ disableRequestLogging: true }),

    // Id curto por request: amarra o log do handler ao da resposta. Se o
    // provedor mandar x-request-id, o dele é reaproveitado.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID().slice(0, 8),

    // O provedor do webhook pode mandar o payload sem content-type correto;
    // manter o body cru disponível facilita adicionar validação HMAC depois.
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  })

  app.addHook('onResponse', (req, reply, done) => {
    const status = reply.statusCode
    const level =
      status >= 500 ? 'error' : status >= 400 ? 'warn' : isNoisyRoute(req.url) ? 'debug' : 'info'

    req.log[level](
      {
        method: req.method,
        url: req.url,
        status,
        ms: Math.round(reply.elapsedTime),
        ip: req.ip,
        ua: req.headers['user-agent'],
      },
      'requisição',
    )
    done()
  })

  // Payload inválido não deve virar 500 nem derrubar o handler.
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    const status = err.statusCode ?? 500
    // Erro do cliente (400/401/413) é ruído em nível de error: quem precisa
    // agir é o provedor, não a operação da VPS.
    const level = status >= 500 ? 'error' : 'warn'
    req.log[level]({ err, status, method: req.method, url: req.url }, 'erro na requisição')
    reply.code(status).send({ error: status === 500 ? 'internal_error' : err.message })
  })

  // Mesmo formato de erro das demais rotas. O log já sai no onResponse (404 → warn).
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not_found' })
  })

  app.register(healthRoutes)
  app.register(webhookRoutes)
  app.register(whatsappRoutes)

  return app
}
