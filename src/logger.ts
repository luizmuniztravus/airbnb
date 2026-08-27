import { pino } from 'pino'
import { env } from './config/env.js'

// Sob pm2 não há TTY: colorir só encheria os arquivos de log de escapes ANSI.
const colorize = Boolean(process.stdout.isTTY)

// pm2 exporta o id da instância — útil para diferenciar processos após restart.
const pmId = process.env.pm_id

/**
 * Campos que nunca podem aparecer no log. Os arquivos do pm2 ficam em disco na
 * VPS e são lidos por qualquer um com acesso ao servidor; o token do webhook
 * chega em todo request e vazaria junto com os headers.
 */
const REDACT_PATHS = [
  'req.headers["x-webhook-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers["x-webhook-token"]',
  'headers.authorization',
  'WEBHOOK_SECRET',
  '*.WEBHOOK_SECRET',
]

export const logger = pino({
  level: env.LOG_LEVEL,

  // ISO em vez do epoch: os logs do pm2 são lidos com `tail`/`grep`, sem nada
  // no caminho para reformatar o timestamp.
  timestamp: pino.stdTimeFunctions.isoTime,

  // `hostname` não agrega nada numa VPS de um processo só; pid e pmId sim,
  // porque revelam restart em loop quando a mesma mensagem reaparece.
  base: { pid: process.pid, ...(pmId !== undefined ? { pmId: Number(pmId) } : {}) },

  redact: { paths: REDACT_PATHS, censor: '[redigido]' },

  ...(env.LOG_FORMAT === 'pretty'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize,
            // Data completa: `pm2 logs` mostra várias sessões no mesmo arquivo.
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            // `mod` vira prefixo — `[outbox] mensagem enviada` — em vez de
            // mais um par chave/valor no fim da linha.
            messageFormat: '{if mod}[{mod}] {end}{msg}',
            ignore: 'pid,hostname,pmId,mod',
            errorLikeObjectKeys: ['err', 'error'],
          },
        },
      }
    : {}),
})
