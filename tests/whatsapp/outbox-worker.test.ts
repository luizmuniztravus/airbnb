import { resetDb, seedEvent, getOutboxRow, setNextAttempt } from '../helpers/db.js'
import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { enqueue, MAX_ATTEMPTS } from '../../src/db/outbox.js'

const JID = '1234567890-1234567890@g.us'

/**
 * O worker fala com `client.js` e `sender.js` — ambos trocados por dublês aqui.
 * Exige `--experimental-test-module-mocks` (já no script `npm test`).
 */
let conectado = true
let enviados: { jid: string; body: string }[] = []
let falharCom: Error | undefined
/** Chamado depois de cada envio — usado para derrubar a conexão no meio do lote. */
let aposEnvio: (() => void) | undefined

mock.module('../../src/whatsapp/client.js', {
  exports: {
    isConnected: () => conectado,
    getStatus: () => (conectado ? 'open' : 'disconnected'),
  },
})

mock.module('../../src/whatsapp/sender.js', {
  exports: {
    sendText: async (jid: string, body: string) => {
      if (falharCom) throw falharCom
      enviados.push({ jid, body })
      aposEnvio?.()
      return 'msg-id'
    },
  },
})

const { startOutboxWorker, stopOutboxWorker } = await import('../../src/whatsapp/outbox.js')

const TICK_MS = 5_000

/** Avança um tick do worker e espera o ciclo assíncrono terminar. */
async function tick(): Promise<void> {
  mock.timers.tick(TICK_MS)
  // O `setInterval` dispara `void tick()`: é preciso ceder o event loop para
  // que os envios (promessas) e as escritas no banco completem.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

function enfileira(body: string): number {
  return enqueue({ eventId: seedEvent(), targetJid: JID, body })
}

describe('worker do outbox', () => {
  beforeEach(() => {
    resetDb()
    conectado = true
    enviados = []
    falharCom = undefined
    aposEnvio = undefined
    mock.timers.enable({ apis: ['setInterval'] })
    startOutboxWorker()
  })

  afterEach(() => {
    stopOutboxWorker()
    mock.timers.reset()
  })

  test('envia as pendentes e marca como sent', async () => {
    const id = enfileira('olá grupo')
    await tick()

    assert.deepEqual(enviados, [{ jid: JID, body: 'olá grupo' }])
    assert.equal(getOutboxRow(id).status, 'sent')
    assert.equal(getOutboxRow(id).attempts, 1)
  })

  test('não tenta nada enquanto o WhatsApp está desconectado', async () => {
    const id = enfileira('presa')
    conectado = false
    await tick()

    assert.deepEqual(enviados, [])
    const row = getOutboxRow(id)
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 0, 'ficar offline não pode gastar tentativa')
  })

  test('a mensagem presa sai assim que a conexão volta', async () => {
    const id = enfileira('presa')
    conectado = false
    await tick()
    conectado = true
    await tick()

    assert.equal(enviados.length, 1)
    assert.equal(getOutboxRow(id).status, 'sent')
  })

  test('falha no envio reagenda com backoff em vez de perder a mensagem', async () => {
    const id = enfileira('vai falhar')
    falharCom = new Error('timeout do socket')
    await tick()

    const row = getOutboxRow(id)
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 1)
    assert.equal(row.last_error, 'timeout do socket')
    assert.ok(Date.parse(row.next_attempt_at) > Date.now(), 'deve ficar agendada para o futuro')
  })

  test('o backoff segura a mensagem até a hora marcada', async () => {
    const id = enfileira('vai falhar')
    falharCom = new Error('timeout')
    await tick()

    // Tick imediatamente depois: ainda dentro dos 5s de espera.
    await tick()
    assert.equal(getOutboxRow(id).attempts, 1, 'não deve tentar de novo antes da hora')
  })

  test('esgotadas as tentativas, marca failed e para de tentar', async () => {
    const id = enfileira('sempre falha')
    falharCom = new Error('destino inválido')

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Antecipa o agendamento: o backoff usa o relógio real do banco.
      setNextAttempt(id, new Date(Date.now() - 1000))
      await tick()
    }

    const row = getOutboxRow(id)
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, MAX_ATTEMPTS)

    // E não volta mais para a fila, mesmo com o agendamento no passado.
    setNextAttempt(id, new Date(Date.now() - 1000))
    await tick()
    assert.equal(getOutboxRow(id).attempts, MAX_ATTEMPTS)
  })

  test('processa o lote em ordem', async () => {
    enfileira('primeira')
    enfileira('segunda')
    enfileira('terceira')
    await tick()

    assert.deepEqual(
      enviados.map((e) => e.body),
      ['primeira', 'segunda', 'terceira'],
    )
  })

  test('conexão caindo no meio do lote não gasta tentativa das restantes', async () => {
    const ids = [enfileira('a'), enfileira('b'), enfileira('c')]
    // Derruba a conexão logo depois do primeiro envio; o segundo falha e o
    // worker interrompe o lote em vez de queimar as tentativas restantes.
    aposEnvio = () => {
      conectado = false
      falharCom = new Error('conexão perdida')
    }
    await tick()

    assert.equal(enviados.length, 1)
    assert.equal(getOutboxRow(ids[0]!).status, 'sent')
    assert.equal(getOutboxRow(ids[1]!).attempts, 1, 'a que estava em voo conta a tentativa')
    assert.equal(getOutboxRow(ids[2]!).attempts, 0, 'as seguintes ficam intactas')
    assert.equal(getOutboxRow(ids[2]!).status, 'pending')
  })

  test('startOutboxWorker é idempotente', async () => {
    startOutboxWorker()
    startOutboxWorker()
    enfileira('uma vez só')
    await tick()

    assert.equal(enviados.length, 1, 'não deve haver dois timers enviando')
  })

  test('stopOutboxWorker interrompe o ciclo', async () => {
    stopOutboxWorker()
    enfileira('não deve sair')
    await tick()

    assert.deepEqual(enviados, [])
  })
})
