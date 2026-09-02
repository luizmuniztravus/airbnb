import { TEST_SECRET, TEST_GROUP_JID } from '../helpers/setup.js'
import { resetDb, db, getOutboxRow } from '../helpers/db.js'
import { buildWebhookApp } from '../helpers/app.js'
import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { env } from '../../src/config/env.js'
import { listRecentEvents } from '../../src/db/events.js'

const URL = '/webhooks/nova-reserva'

let app: FastifyInstance

function post(payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: URL,
    headers: { 'x-webhook-token': TEST_SECRET, ...headers },
    payload: payload as object,
  })
}

function dedupeKeys(): string[] {
  return listRecentEvents(100).map((e) => e.dedupe_key)
}

before(async () => {
  app = await buildWebhookApp()
})
after(async () => {
  await app.close()
})

describe('POST /webhooks/nova-reserva — autenticação', () => {
  beforeEach(() => {
    resetDb()
    env.WHATSAPP_GROUP_JID = TEST_GROUP_JID
  })

  test('401 sem token, e nada é gravado', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { id: 'RES-1' } })

    assert.equal(res.statusCode, 401)
    assert.deepEqual(listRecentEvents(), [])
  })

  test('401 com token errado', async () => {
    const res = await post({ id: 'RES-1' }, { 'x-webhook-token': 'errado' })
    assert.equal(res.statusCode, 401)
  })

  test('aceita Bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${TEST_SECRET}` },
      payload: { id: 'RES-1' },
    })
    assert.equal(res.statusCode, 200)
  })
})

describe('POST /webhooks/nova-reserva — enfileiramento', () => {
  beforeEach(() => {
    resetDb()
    env.WHATSAPP_GROUP_JID = TEST_GROUP_JID
  })

  test('enfileira a mensagem e devolve 200 imediatamente', async () => {
    const res = await post({
      id: 'RES-001',
      guest: { name: 'João Silva' },
      listing: { name: 'Apto 302' },
      check_in: '2026-08-27',
      check_out: '2026-08-30',
      guests: 2,
    })

    assert.equal(res.statusCode, 200)
    const body = res.json() as { status: string; eventId: number; outboxId: number }
    assert.equal(body.status, 'queued')
    assert.ok(body.eventId > 0)
    assert.ok(body.outboxId > 0)

    const row = getOutboxRow(body.outboxId)
    assert.equal(row.event_id, body.eventId)
    assert.equal(row.target_jid, TEST_GROUP_JID)
    assert.equal(row.status, 'pending')
    assert.match(row.body, /👤 João Silva/)
    assert.match(row.body, /📅 27\/08\/2026 → 30\/08\/2026/)
  })

  test('grava o payload cru exatamente como veio', async () => {
    const payload = { id: 'RES-2', extra: { lista: [1, 2, 3] } }
    await post(payload)

    const [evento] = listRecentEvents()
    assert.ok(evento)
    assert.deepEqual(JSON.parse(evento.raw_payload) as unknown, payload)
    assert.equal(evento.source, 'nova-reserva')
  })

  test('aceita payload sem nenhum campo conhecido', async () => {
    const res = await post({ formato: 'desconhecido' })

    assert.equal(res.json().status, 'queued')
    const row = getOutboxRow((res.json() as { outboxId: number }).outboxId)
    assert.match(row.body, /Formato não reconhecido/)
  })

  test('aceita corpo vazio sem virar 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { 'x-webhook-token': TEST_SECRET },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().status, 'queued')
    assert.deepEqual(dedupeKeys(), ['nova-reserva:sha256:' + sha256('{}')])
  })
})

describe('POST /webhooks/nova-reserva — chave de deduplicação', () => {
  beforeEach(() => {
    resetDb()
    env.WHATSAPP_GROUP_JID = TEST_GROUP_JID
  })

  test('usa o primeiro campo de id disponível, na ordem definida', async () => {
    await post({ id: 'do-id', reservation_id: 'do-reservation' })
    assert.deepEqual(dedupeKeys(), ['nova-reserva:do-id'])
  })

  test('cai para os campos alternativos quando não há `id`', async () => {
    const casos: [Record<string, unknown>, string][] = [
      [{ event_id: 'E1' }, 'nova-reserva:E1'],
      [{ reservation_id: 'R1' }, 'nova-reserva:R1'],
      [{ booking_id: 'B1' }, 'nova-reserva:B1'],
      [{ confirmation_code: 'C1' }, 'nova-reserva:C1'],
      [{ reservation_code: 'RC1' }, 'nova-reserva:RC1'],
      [{ uuid: 'U1' }, 'nova-reserva:U1'],
      [{ booking_uuid: 'BU1' }, 'nova-reserva:BU1'],
    ]

    for (const [payload, esperado] of casos) {
      resetDb()
      await post(payload)
      assert.deepEqual(dedupeKeys(), [esperado], JSON.stringify(payload))
    }
  })

  test('aceita id numérico e faz trim de id textual', async () => {
    await post({ id: 42 })
    await post({ id: '  RES-3  ' })
    assert.deepEqual(dedupeKeys().sort(), ['nova-reserva:42', 'nova-reserva:RES-3'].sort())
  })

  test('sem campo de id, usa o sha256 do payload', async () => {
    const payload = { guest_name: 'Ana', check_in: '2026-01-01' }
    await post(payload)
    assert.deepEqual(dedupeKeys(), ['nova-reserva:sha256:' + sha256(JSON.stringify(payload))])
  })

  test('id vazio não vira chave — cai no hash', async () => {
    await post({ id: '   ' })
    const [chave] = dedupeKeys()
    assert.match(chave ?? '', /^nova-reserva:sha256:/)
  })

  test('reprocessamento no provedor não escapa da deduplicação', async () => {
    // Payload real: o id da reserva vem em `booking_uuid`, e o corpo carrega
    // `_workflow_execution_id`, que muda a cada execução do workflow. Enquanto
    // `booking_uuid` não era reconhecido, a chave era o hash do corpo inteiro —
    // então reprocessar a mesma reserva gerava chave nova e o grupo recebia a
    // mensagem duas vezes.
    const reserva = {
      guest_name: 'Fulano de Tal',
      property_name: 'Chalé 01',
      check_in: '26/10/2026',
      check_out: '28/10/2026',
      booking_uuid: '049f6f2f-fa2b-4011-93ab-e3cd0ca7e347',
      _workflow_id: 38,
      _workflow_execution_id: 968,
    }

    const primeira = await post(reserva)
    assert.equal(primeira.json().status, 'queued')

    // Mesma reserva, outra execução do workflow: corpo diferente, reserva igual.
    const segunda = await post({ ...reserva, _workflow_execution_id: 969 })
    assert.equal(segunda.json().status, 'duplicate')

    assert.deepEqual(dedupeKeys(), [
      'nova-reserva:049f6f2f-fa2b-4011-93ab-e3cd0ca7e347',
    ])
  })
})

describe('POST /webhooks/nova-reserva — idempotência', () => {
  beforeEach(() => {
    resetDb()
    env.WHATSAPP_GROUP_JID = TEST_GROUP_JID
  })

  test('reenvio do mesmo id não duplica a mensagem no grupo', async () => {
    const primeira = await post({ id: 'RES-1', guest_name: 'Ana' })
    const segunda = await post({ id: 'RES-1', guest_name: 'Ana' })

    assert.equal(primeira.json().status, 'queued')
    assert.equal(segunda.json().status, 'duplicate')
    assert.equal(segunda.json().eventId, primeira.json().eventId)
    assert.equal(contaOutbox(), 1)
  })

  test('mesmo id com corpo diferente ainda é duplicado', async () => {
    await post({ id: 'RES-1', guest_name: 'Ana' })
    const segunda = await post({ id: 'RES-1', guest_name: 'Outro Nome' })

    assert.equal(segunda.json().status, 'duplicate')
    assert.equal(contaOutbox(), 1)
  })

  test('payloads idênticos sem id são deduplicados pelo hash', async () => {
    await post({ guest_name: 'Ana' })
    const segunda = await post({ guest_name: 'Ana' })

    assert.equal(segunda.json().status, 'duplicate')
    assert.equal(contaOutbox(), 1)
  })

  test('payloads diferentes sem id geram mensagens separadas', async () => {
    await post({ guest_name: 'Ana' })
    const segunda = await post({ guest_name: 'Bruno' })

    assert.equal(segunda.json().status, 'queued')
    assert.equal(contaOutbox(), 2)
  })

  test('ids diferentes geram mensagens separadas', async () => {
    await post({ id: 'RES-1' })
    const segunda = await post({ id: 'RES-2' })

    assert.equal(segunda.json().status, 'queued')
    assert.equal(contaOutbox(), 2)
  })
})

describe('POST /webhooks/nova-reserva — sem grupo configurado', () => {
  beforeEach(() => {
    resetDb()
    delete env.WHATSAPP_GROUP_JID
  })

  test('grava o evento e responde stored_no_target', async () => {
    const res = await post({ id: 'RES-1', guest_name: 'Ana' })
    const body = res.json() as { status: string; eventId: number; hint: string }

    assert.equal(res.statusCode, 200)
    assert.equal(body.status, 'stored_no_target')
    assert.ok(body.eventId > 0)
    assert.match(body.hint, /WHATSAPP_GROUP_JID/)
    assert.equal(contaOutbox(), 0)
    assert.equal(listRecentEvents().length, 1)
  })

  test('reenvio depois de configurar o grupo recupera o evento preso', async () => {
    // É o ponto do `hasMessageForEvent` no handler: um evento gravado antes de
    // existir destino não pode ficar marcado como duplicado para sempre.
    const payload = { id: 'RES-1', guest_name: 'Ana' }

    const antes = await post(payload)
    assert.equal(antes.json().status, 'stored_no_target')

    env.WHATSAPP_GROUP_JID = TEST_GROUP_JID
    const depois = await post(payload)

    assert.equal(depois.json().status, 'queued')
    assert.equal(depois.json().eventId, antes.json().eventId, 'reaproveita o evento já gravado')
    assert.equal(contaOutbox(), 1)
    assert.equal(listRecentEvents().length, 1, 'não duplica o evento')

    // E a partir daí volta a deduplicar normalmente.
    const terceira = await post(payload)
    assert.equal(terceira.json().status, 'duplicate')
    assert.equal(contaOutbox(), 1)
  })
})

function contaOutbox(): number {
  return (db.prepare('SELECT COUNT(*) as n FROM outbox').get() as { n: number }).n
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
