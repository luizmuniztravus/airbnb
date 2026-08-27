import { env } from './config/env.js'
import { logger } from './logger.js'
import { closeDb } from './db/index.js'
import { buildServer } from './server.js'
import { connect, disconnect } from './whatsapp/client.js'
import { startOutboxWorker, stopOutboxWorker } from './whatsapp/outbox.js'

async function main() {
  const app = buildServer()

  // A conexão do WhatsApp não bloqueia o boot: o HTTP precisa aceitar webhooks
  // mesmo antes do pareamento — o outbox segura as mensagens até conectar.
  connect().catch((err) => logger.error({ err }, 'falha na conexão inicial do WhatsApp'))

  startOutboxWorker()

  await app.listen({ port: env.PORT, host: env.HOST })
  logger.info({ port: env.PORT }, 'servidor pronto')

  if (!env.WHATSAPP_GROUP_JID) {
    logger.warn(
      'WHATSAPP_GROUP_JID não definido — eventos serão salvos mas não enviados. ' +
        'Pareie o QR e chame GET /whatsapp/groups para descobrir o JID.',
    )
  }

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'encerrando')
    stopOutboxWorker()
    await app.close()
    await disconnect()
    closeDb()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'falha fatal no boot')
  process.exit(1)
})
