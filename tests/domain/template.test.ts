import '../helpers/setup.js'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatCheckinMessage } from '../../src/domain/template.js'
import { normalizeCheckin, type CheckinEvent } from '../../src/domain/checkin.js'

function evento(partial: Partial<CheckinEvent> = {}): CheckinEvent {
  return { raw: {}, ...partial }
}

describe('formatCheckinMessage', () => {
  test('monta a mensagem completa na ordem esperada', () => {
    const msg = formatCheckinMessage(
      normalizeCheckin({
        id: 'RES-001',
        guest: { name: 'João Silva' },
        listing: { name: 'Apto 302' },
        check_in: '2026-08-27',
        check_out: '2026-08-30',
        guests: 2,
        channel: 'Airbnb',
      }),
    )

    const linhas = msg.split('\n')
    assert.equal(linhas[0], '✅ *Check-in realizado*')
    assert.equal(linhas[1], '')
    assert.equal(linhas[2], '👤 João Silva')
    assert.equal(linhas[3], '🏠 Apto 302')
    assert.equal(linhas[4], '📅 27/08/2026 → 30/08/2026')
    assert.equal(linhas[5], '👥 2 hóspedes')
    assert.equal(linhas[6], '🔖 RES-001')
    assert.equal(linhas[7], '🌐 Airbnb')
  })

  test('converte yyyy-mm-dd para dd/mm/aaaa', () => {
    const msg = formatCheckinMessage(evento({ checkIn: '2026-08-27' }))
    assert.match(msg, /📅 27\/08\/2026/)
  })

  test('aceita ISO completo, usando só a data', () => {
    const msg = formatCheckinMessage(evento({ checkIn: '2026-08-27T14:30:00.000Z' }))
    assert.match(msg, /📅 27\/08\/2026/)
  })

  test('deixa passar formato desconhecido sem tentar converter', () => {
    const msg = formatCheckinMessage(evento({ checkIn: 'sexta-feira à tarde' }))
    assert.match(msg, /📅 sexta-feira à tarde/)
  })

  test('sem check-out, mostra apenas a data de entrada', () => {
    const msg = formatCheckinMessage(evento({ checkIn: '2026-08-27' }))
    assert.match(msg, /📅 27\/08\/2026$/m)
    assert.doesNotMatch(msg, /→/)
  })

  test('check-out sozinho não gera linha de data', () => {
    // Documenta o comportamento atual: a data de saída só aparece acompanhada
    // da entrada. Um check-out isolado não faz sentido para o grupo.
    const msg = formatCheckinMessage(evento({ checkOut: '2026-08-30' }))
    assert.doesNotMatch(msg, /📅/)
  })

  test('concorda o plural de hóspede', () => {
    assert.match(formatCheckinMessage(evento({ hospedes: 1 })), /👥 1 hóspede$/m)
    assert.match(formatCheckinMessage(evento({ hospedes: 2 })), /👥 2 hóspedes$/m)
    assert.match(formatCheckinMessage(evento({ hospedes: 0 })), /👥 0 hóspedes$/m)
  })

  test('omite as linhas dos campos ausentes', () => {
    const msg = formatCheckinMessage(evento({ hospede: 'Ana' }))
    assert.match(msg, /👤 Ana/)
    for (const emoji of ['🏠', '📅', '👥', '🔖', '🌐']) {
      assert.equal(msg.includes(emoji), false, `não deveria conter ${emoji}`)
    }
  })

  test('avisa quando o payload não foi mapeado', () => {
    const msg = formatCheckinMessage(normalizeCheckin({ foo: 'bar' }))
    assert.match(msg, /⚠️ _Payload ainda não mapeado/)
  })

  test('não avisa quando algum campo-âncora foi reconhecido', () => {
    const msg = formatCheckinMessage(normalizeCheckin({ guest_name: 'Ana' }))
    assert.doesNotMatch(msg, /não mapeado/)
  })

  test('anexa o payload cru em bloco de código', () => {
    const raw = { id: 'RES-9', nested: { a: 1 } }
    const msg = formatCheckinMessage(normalizeCheckin(raw))
    assert.match(msg, /_payload:_/)
    assert.match(msg, /```/)
    assert.match(msg, /"id": "RES-9"/)
  })

  test('trunca payloads gigantes para não estourar a mensagem', () => {
    const raw = { itens: Array.from({ length: 500 }, (_, i) => `item-${i}`) }
    const msg = formatCheckinMessage(normalizeCheckin(raw))

    assert.match(msg, /… \(truncado\)/)
    // O JSON completo teria bem mais que o limite de 1500 caracteres.
    assert.ok(JSON.stringify(raw, null, 2).length > 1500)
    assert.ok(msg.length < 2000, `mensagem ficou com ${msg.length} caracteres`)
  })

  test('não trunca payload dentro do limite', () => {
    const msg = formatCheckinMessage(normalizeCheckin({ id: 'RES-1' }))
    assert.doesNotMatch(msg, /truncado/)
  })

  test('formata payload null', () => {
    const msg = formatCheckinMessage(normalizeCheckin(null))
    assert.match(msg, /✅ \*Check-in realizado\*/)
    assert.match(msg, /null/)
  })

  test(
    'raw undefined deveria virar mensagem, não exceção',
    // JSON.stringify(undefined) devolve undefined e `truncate` estoura em
    // `text.length`. Hoje é inalcançável pela rota (`req.body ?? {}`), mas
    // deixa a função frágil para qualquer outro chamador.
    { todo: 'tratar em template.ts: JSON.stringify(evt.raw) pode ser undefined' },
    () => {
      const msg = formatCheckinMessage({ raw: undefined })
      assert.match(msg, /✅ \*Check-in realizado\*/)
    },
  )
})
