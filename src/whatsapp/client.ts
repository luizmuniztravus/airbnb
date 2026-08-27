import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  type WASocket,
} from 'baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import { rm } from 'node:fs/promises'
import { env } from '../config/env.js'
import { logger } from '../logger.js'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr' | 'open'

const log = logger.child({ mod: 'whatsapp' })

// Baileys é muito verboso em info; mantemos o socket em 'warn' salvo em debug.
const baileysLogger = logger.child(
  { mod: 'baileys' },
  { level: env.LOG_LEVEL === 'trace' || env.LOG_LEVEL === 'debug' ? env.LOG_LEVEL : 'warn' },
)

let sock: WASocket | undefined
let status: ConnectionStatus = 'disconnected'
let currentQr: string | undefined
let reconnectAttempts = 0
let reconnectTimer: NodeJS.Timeout | undefined
let stopped = false
let openedAt: number | undefined

/** Nome do código de desconexão do Baileys — 428 sozinho não diz nada no log. */
function nomeDoMotivo(code: number | undefined): string {
  if (code === undefined) return 'desconhecido'
  const entry = Object.entries(DisconnectReason).find(([, v]) => v === code)
  return entry?.[0] ?? 'desconhecido'
}

export function getStatus(): ConnectionStatus {
  return status
}

export function getQr(): string | undefined {
  return currentQr
}

export function isConnected(): boolean {
  return status === 'open' && sock !== undefined
}

/** Só devolve o socket quando a conexão está de fato aberta. */
export function getSocket(): WASocket {
  if (!sock || status !== 'open') {
    throw new Error(`WhatsApp não conectado (status: ${status})`)
  }
  return sock
}

function scheduleReconnect() {
  if (stopped) return
  // 2s, 4s, 8s ... teto de 60s, para não martelar o servidor do WhatsApp.
  const delay = Math.min(2_000 * 2 ** reconnectAttempts, 60_000)
  reconnectAttempts += 1
  // Depois de 5 tentativas já não é oscilação de rede: sobe para warn para
  // aparecer mesmo em quem filtra o log por nível.
  const level = reconnectAttempts > 5 ? 'warn' : 'info'
  log[level]({ delayMs: delay, attempt: reconnectAttempts }, 'reagendando reconexão')
  reconnectTimer = setTimeout(() => {
    connect().catch((err) => {
      log.error({ err }, 'falha ao reconectar')
      scheduleReconnect()
    })
  }, delay)
}

export async function connect(): Promise<void> {
  if (stopped) return
  status = 'connecting'

  const { state, saveCreds } = await useMultiFileAuthState(env.AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  log.info({ waVersion: version.join('.') }, 'abrindo socket')

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // O cache reduz drasticamente a leitura de arquivos de sessão.
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    browser: Browsers.ubuntu('Check-in Notifier'),
    // Não marcar como online: evita que as notificações do celular parem
    // de chegar enquanto este serviço estiver rodando.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      currentQr = qr
      status = 'qr'
      log.warn('escaneie o QR code abaixo com o WhatsApp do número dedicado')
      // Vai direto ao stdout, sem passar pelo logger: os blocos precisam sair
      // crus para o QR continuar escaneável em `npm run pm2:logs`.
      qrcode.generate(qr, { small: true })
      log.warn('se o QR não renderizar no seu terminal, pegue a string em GET /whatsapp/status')
    }

    if (connection === 'open') {
      currentQr = undefined
      status = 'open'
      openedAt = Date.now()
      log.info(
        { jid: sock?.user?.id, aposTentativas: reconnectAttempts },
        'conexão aberta',
      )
      reconnectAttempts = 0
      return
    }

    if (connection === 'close') {
      status = 'disconnected'
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const conexaoDurouMs = openedAt !== undefined ? Date.now() - openedAt : undefined
      openedAt = undefined

      // Fechamento provocado pelo próprio shutdown: não é incidente.
      if (stopped) {
        log.debug({ conexaoDurouMs }, 'socket fechado durante o encerramento')
        return
      }

      if (statusCode === DisconnectReason.loggedOut) {
        // Sessão invalidada no celular: as credenciais não servem mais.
        log.error(
          { statusCode, motivo: nomeDoMotivo(statusCode), conexaoDurouMs },
          'sessão encerrada no aparelho — limpando credenciais, será preciso novo QR',
        )
        void rm(env.AUTH_DIR, { recursive: true, force: true })
          .then(() => {
            reconnectAttempts = 0
            scheduleReconnect()
          })
          .catch((err) => log.error({ err }, 'falha ao limpar AUTH_DIR'))
        return
      }

      if (statusCode === DisconnectReason.restartRequired) {
        // Esperado logo após parear: reconectar de imediato.
        log.info({ statusCode, motivo: nomeDoMotivo(statusCode) }, 'restart solicitado pelo WhatsApp — reconectando')
        reconnectAttempts = 0
        void connect().catch((err) => {
          log.error({ err }, 'falha no restart')
          scheduleReconnect()
        })
        return
      }

      log.warn(
        {
          statusCode,
          motivo: nomeDoMotivo(statusCode),
          conexaoDurouMs,
          err: lastDisconnect?.error?.message,
        },
        'conexão fechada',
      )
      scheduleReconnect()
    }
  })
}

export async function disconnect(): Promise<void> {
  stopped = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  try {
    // end() sem erro fecha o socket sem deslogar — a sessão continua válida.
    sock?.end(undefined)
  } catch (err) {
    log.warn({ err }, 'erro ao fechar socket')
  }
  sock = undefined
  status = 'disconnected'
}
