import { resetDb, getEventRow } from '../helpers/db.js'
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { insertEvent, listRecentEvents } from '../../src/db/events.js'

describe('insertEvent', () => {
  beforeEach(resetDb)

  test('grava um evento novo', () => {
    const result = insertEvent({
      dedupeKey: 'nova-reserva:RES-1',
      source: 'nova-reserva',
      rawPayload: '{"id":"RES-1"}',
    })

    assert.equal(result.isDuplicate, false)
    assert.ok(result.id > 0)

    const row = getEventRow(result.id)
    assert.equal(row.dedupe_key, 'nova-reserva:RES-1')
    assert.equal(row.source, 'nova-reserva')
    assert.equal(row.raw_payload, '{"id":"RES-1"}')
    assert.ok(!Number.isNaN(Date.parse(row.received_at)), 'received_at deve ser ISO válido')
  })

  test('a mesma dedupeKey devolve o id existente e marca duplicado', () => {
    const first = insertEvent({ dedupeKey: 'k', source: 's', rawPayload: '{"v":1}' })
    const second = insertEvent({ dedupeKey: 'k', source: 's', rawPayload: '{"v":2}' })

    assert.equal(second.isDuplicate, true)
    assert.equal(second.id, first.id)
  })

  test('duplicado não sobrescreve o payload gravado da primeira vez', () => {
    const first = insertEvent({ dedupeKey: 'k', source: 's', rawPayload: '{"v":1}' })
    insertEvent({ dedupeKey: 'k', source: 's', rawPayload: '{"v":2}' })

    assert.equal(getEventRow(first.id).raw_payload, '{"v":1}')
    assert.equal(listRecentEvents().length, 1)
  })

  test('chaves diferentes geram eventos distintos', () => {
    const a = insertEvent({ dedupeKey: 'a', source: 's', rawPayload: '{}' })
    const b = insertEvent({ dedupeKey: 'b', source: 's', rawPayload: '{}' })

    assert.equal(b.isDuplicate, false)
    assert.notEqual(a.id, b.id)
  })
})

describe('listRecentEvents', () => {
  beforeEach(resetDb)

  test('devolve os mais recentes primeiro', () => {
    for (const key of ['a', 'b', 'c']) {
      insertEvent({ dedupeKey: key, source: 's', rawPayload: `{"k":"${key}"}` })
    }

    const events = listRecentEvents()
    assert.deepEqual(
      events.map((e) => e.dedupe_key),
      ['c', 'b', 'a'],
    )
  })

  test('respeita o limite', () => {
    for (let i = 0; i < 5; i++) {
      insertEvent({ dedupeKey: `k${i}`, source: 's', rawPayload: '{}' })
    }

    assert.equal(listRecentEvents(2).length, 2)
    assert.equal(listRecentEvents().length, 5)
  })

  test('banco vazio devolve lista vazia', () => {
    assert.deepEqual(listRecentEvents(), [])
  })
})
