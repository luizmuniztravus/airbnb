import { env } from './config/env.js'
import { logger } from './logger.js'
import { closeDb } from './db/index.js'
import { stats } from './db/outbox.js'
import { buildServer } from './server.js'
import { connect, disconnect, getStatus } from './whatsapp/client.js'
import { startOutboxWorker, stopOutboxWorker } from './whatsapp/outbox.js'

/**
 * Em modo `pretty` o pino-pretty roda numa worker thread: um `process.exit()`
 * imediato engole justamente as últimas linhas — as que explicam a queda.
 */
function sairApos(code: number) {
  logger.flush()
  setTimeout(() => process.exit(code), 150)
}

/**
 * Erro fora de qualquer try/catch derruba o processo. Sem isto o pm2 reinicia e
 * a única pista fica na saída crua do Node, sem timestamp nem contexto.
 */
function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'exceção não tratada — encerrando para o pm2 reiniciar')
    sairApos(1)
  })

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'promise rejeitada sem catch — encerrando para o pm2 reiniciar')
    sairApos(1)
  })

  // pm2 avisa antes de matar por max_memory_restart; registrar ajuda a
  // diferenciar reinício por memória de queda por erro.
  process.on('warning', (warning) => {
    logger.warn({ name: warning.name, msg: warning.message }, 'warning do Node')
  })
}

async function main() {
  installCrashHandlers()

  logger.info(
    {
      node: process.version,
      env: process.env.NODE_ENV ?? 'development',
      logLevel: env.LOG_LEVEL,
      logFormat: env.LOG_FORMAT,
      port: env.PORT,
      host: env.HOST,
      dbPath: env.DB_PATH,
      authDir: env.AUTH_DIR,
      groupJid: env.WHATSAPP_GROUP_JID ?? null,
    },
    'iniciando notificador de check-in',
  )

  const app = buildServer()

  // A conexão do WhatsApp não bloqueia o boot: o HTTP precisa aceitar webhooks
  // mesmo antes do pareamento — o outbox segura as mensagens até conectar.
  connect().catch((err) => logger.error({ err }, 'falha na conexão inicial do WhatsApp'))

  startOutboxWorker()

  await app.listen({ port: env.PORT, host: env.HOST })

  // Fila que sobrou do processo anterior: sem isto um restart esconde que
  // existem mensagens paradas esperando conexão.
  const pendentes = Object.fromEntries(stats().map((s) => [s.status, s.count]))
  logger.info({ port: env.PORT, outbox: pendentes }, 'servidor pronto')

  if (!env.WHATSAPP_GROUP_JID) {
    logger.warn(
      'WHATSAPP_GROUP_JID não definido — eventos serão salvos mas não enviados. ' +
        'Pareie o QR e chame GET /whatsapp/groups para descobrir o JID.',
    )
  }

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'sinal repetido durante o encerramento — ignorado')
      return
    }
    shuttingDown = true

    const startedAt = Date.now()
    logger.info({ signal, whatsapp: getStatus() }, 'encerrando')

    try {
      stopOutboxWorker()
      await app.close()
      await disconnect()
      closeDb()
      logger.info({ signal, ms: Date.now() - startedAt }, 'encerrado com sucesso')
      sairApos(0)
    } catch (err) {
      // Sai mesmo assim: travar aqui faria o pm2 esperar o kill_timeout inteiro.
      logger.error({ err, ms: Date.now() - startedAt }, 'falha ao encerrar limpo')
      sairApos(1)
    }
  }

  // SIGINT/SIGTERM: `pm2 stop`/`pm2 restart`. SIGHUP chega em `pm2 reload`.
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGHUP', () => void shutdown('SIGHUP'))
}

main().catch((err) => {
  logger.fatal({ err }, 'falha fatal no boot')
  sairApos(1)
})
