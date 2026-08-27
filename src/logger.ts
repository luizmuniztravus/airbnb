import { pino } from 'pino'
import { env } from './config/env.js'

const isProd = process.env.NODE_ENV === 'production'

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
})
