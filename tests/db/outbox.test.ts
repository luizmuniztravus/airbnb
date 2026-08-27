import { resetDb, seedEvent, getOutboxRow, setNextAttempt } from '../helpers/db.js'
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueue,
  claimPending,
  markSent,
  markFailure,
  hasMessageForEvent,
  stats,
  MAX_ATTEMPTS,
} from '../../src/db/outbox.js'

const JID = '1234567890-1234567890@g.us'

function enfileira(eventId = seedEvent(), body = 'mensagem'): number {
  return enqueue({ eventId, targetJid: JID, body })
}

/** Segundos entre `next_attempt_at` e agora. */
function atrasoEmSegundos(id: number): number {
  return (Date.parse(getOutboxRow(id).next_attempt_at) - Date.now()) / 1000
}

describe('enqueue', () => {
  beforeEach(resetDb)

  test('grava a mensagem pendente e elegível imediatamente', () => {
    const id = enfileira()
    const row = getOutboxRow(id)

    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 0)
    assert.equal(row.target_jid, JID)
    assert.equal(row.last_error, null)
    assert.equal(row.sent_at, null)
    assert.ok(Date.parse(row.next_attempt_at) <= Date.now() + 1000)
    assert.deepEqual(claimPending(), [row])
  })

  test('exige um evento existente (FK)', () => {
    assert.throws(
      () => enqueue({ eventId: 999_999, targetJid: JID, body: 'x' }),
      /FOREIGN KEY/i,
    )
  })
})

describe('hasMessageForEvent', () => {
  beforeEach(resetDb)

  test('false antes de enfileirar, true depois', () => {
    const eventId = seedEvent()
    assert.equal(hasMessageForEvent(eventId), false)
    enfileira(eventId)
    assert.equal(hasMessageForEvent(eventId), true)
  })

  test('continua true depois de enviada ou falhada', () => {
    const eventId = seedEvent()
    const id = enfileira(eventId)
    markSent(id)
    assert.equal(hasMessageForEvent(eventId), true)
  })

  test('não confunde eventos diferentes', () => {
    const comMensagem = seedEvent()
    const semMensagem = seedEvent()
    enfileira(comMensagem)

    assert.equal(hasMessageForEvent(comMensagem), true)
    assert.equal(hasMessageForEvent(semMensagem), false)
  })
})

describe('claimPending', () => {
  beforeEach(resetDb)

  test('devolve em ordem de id (FIFO)', () => {
    const ids = [enfileira(), enfileira(), enfileira()]
    assert.deepEqual(
      claimPending().map((r) => r.id),
      ids,
    )
  })

  test('respeita o limite do lote', () => {
    for (let i = 0; i < 5; i++) enfileira()
    assert.equal(claimPending(2).length, 2)
    assert.equal(claimPending().length, 5)
  })

  test('ignora mensagens agendadas para o futuro', () => {
    const agora = enfileira()
    const depois = enfileira()
    setNextAttempt(depois, new Date(Date.now() + 60_000))

    assert.deepEqual(
      claimPending().map((r) => r.id),
      [agora],
    )
  })

  test('ignora mensagens já enviadas ou definitivamente falhadas', () => {
    const enviada = enfileira()
    const pendente = enfileira()
    markSent(enviada)

    assert.deepEqual(
      claimPending().map((r) => r.id),
      [pendente],
    )
  })
})

describe('markSent', () => {
  beforeEach(resetDb)

  test('marca como enviada, conta a tentativa e limpa o erro', () => {
    const id = enfileira()
    markFailure(getOutboxRow(id), 'falha temporária')
    setNextAttempt(id, new Date(Date.now() - 1000))

    markSent(id)
    const row = getOutboxRow(id)

    assert.equal(row.status, 'sent')
    assert.equal(row.attempts, 2)
    assert.equal(row.last_error, null)
    assert.ok(row.sent_at && !Number.isNaN(Date.parse(row.sent_at)))
    assert.deepEqual(claimPending(), [])
  })
})

describe('markFailure', () => {
  beforeEach(resetDb)

  test('primeira falha reagenda em ~5s e guarda o erro', () => {
    const id = enfileira()
    const outcome = markFailure(getOutboxRow(id), 'socket caiu')

    assert.equal(outcome.retrying, true)
    assert.equal(outcome.attempts, 1)

    const row = getOutboxRow(id)
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 1)
    assert.equal(row.last_error, 'socket caiu')
    assert.ok(atrasoEmSegundos(id) > 3 && atrasoEmSegundos(id) <= 5, 'backoff inicial ~5s')
  })

  test('backoff triplica a cada tentativa: 5s, 15s, 45s, 135s, 405s', () => {
    const id = enfileira()
    const esperados = [5, 15, 45, 135, 405]

    for (const [i, segundos] of esperados.entries()) {
      const outcome = markFailure(getOutboxRow(id), `erro ${i}`)
      assert.equal(outcome.retrying, true, `tentativa ${i + 1} deveria reagendar`)

      const atraso = atrasoEmSegundos(id)
      assert.ok(
        atraso > segundos - 2 && atraso <= segundos,
        `tentativa ${i + 1}: esperado ~${segundos}s, veio ${atraso.toFixed(1)}s`,
      )
    }
  })

  test('esgotadas as tentativas, marca como failed e sai da fila', () => {
    const id = enfileira()

    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      const outcome = markFailure(getOutboxRow(id), `erro ${i}`)
      assert.equal(outcome.retrying, true)
    }

    const ultima = markFailure(getOutboxRow(id), 'erro final')
    assert.equal(ultima.retrying, false)
    assert.equal(ultima.attempts, MAX_ATTEMPTS)

    const row = getOutboxRow(id)
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, MAX_ATTEMPTS)
    assert.equal(row.last_error, 'erro final')

    setNextAttempt(id, new Date(Date.now() - 1000))
    assert.deepEqual(claimPending(), [], 'mensagem falhada não volta para a fila')
  })

  test('não altera next_attempt_at ao falhar definitivamente', () => {
    const id = enfileira()
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) markFailure(getOutboxRow(id), 'e')

    const antes = getOutboxRow(id).next_attempt_at
    markFailure(getOutboxRow(id), 'final')
    assert.equal(getOutboxRow(id).next_attempt_at, antes)
  })
})

describe('stats', () => {
  beforeEach(resetDb)

  test('agrupa por status', () => {
    const pendente = enfileira()
    const enviada = enfileira()
    const falhada = enfileira()

    markSent(enviada)
    for (let i = 0; i < MAX_ATTEMPTS; i++) markFailure(getOutboxRow(falhada), 'e')

    const porStatus = Object.fromEntries(stats().map((s) => [s.status, s.count]))
    assert.deepEqual(porStatus, { pending: 1, sent: 1, failed: 1 })
    assert.equal(getOutboxRow(pendente).status, 'pending')
  })

  test('outbox vazio devolve lista vazia', () => {
    assert.deepEqual(stats(), [])
  })
})
