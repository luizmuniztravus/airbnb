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
        guest_phone: '+55 11 90000 0000',
      }),
    )

    const linhas = msg.split('\n')
    assert.equal(linhas[0], '✅ *Nova Reserva Realizada*')
    assert.equal(linhas[1], '')
    assert.equal(linhas[2], '🏠 Apto 302')
    assert.equal(linhas[3], '📅 27/08/2026 → 30/08/2026')
    assert.equal(linhas[4], '👤 João Silva')
    assert.equal(linhas[5], '👥 2 hóspedes')
    assert.equal(linhas[6], '🌐 Airbnb')
    assert.equal(linhas[7], '☎️ +55 11 90000 0000')
    assert.equal(linhas.length, 8, 'nada além disso — o payload cru não vai mais na mensagem')
  })

  test('payload real do provedor: todos os campos pedidos aparecem', () => {
    // Fixture capturada em produção (dados trocados por fictícios).
    const msg = formatCheckinMessage(
      normalizeCheckin({
        guest_name: 'Fulano de Tal',
        guest_email: 'fulano@guest.booking.com',
        guest_phone: '+55 11 94863 6475',
        property_name: 'Chalé 01',
        check_in: '26/10/2026',
        check_out: '28/10/2026',
        nights: '2',
        guests: '2',
        total_price: '420,00',
        channel: 'booking',
        status: 'confirmed',
        cancellation_reason: '',
        booking_uuid: '049f6f2f-fa2b-4011-93ab-e3cd0ca7e347',
        property_uuid: 'e6239657-2817-4c41-82c0-2b52b069bfa9',
        fnrh_precheckin_link: '',
        _workflow_id: 38,
        _workflow_execution_id: 968,
      }),
    )

    assert.equal(
      msg,
      [
        '✅ *Nova Reserva Realizada*',
        '',
        '🏠 Chalé 01',
        '📅 26/10/2026 → 28/10/2026',
        '👤 Fulano de Tal',
        '👥 2 hóspedes',
        '🌐 Booking',
        '☎️ +55 11 94863 6475',
      ].join('\n'),
    )
  })

  test('não vaza campos que não foram pedidos na mensagem', () => {
    const msg = formatCheckinMessage(
      normalizeCheckin({
        guest_name: 'Fulano',
        guest_email: 'fulano@guest.booking.com',
        total_price: '420,00',
        booking_uuid: '049f6f2f-fa2b-4011-93ab-e3cd0ca7e347',
        property_uuid: 'e6239657-2817-4c41-82c0-2b52b069bfa9',
      }),
    )

    // E-mail, valor e UUIDs ficam no banco, não no grupo.
    assert.doesNotMatch(msg, /guest\.booking\.com/)
    assert.doesNotMatch(msg, /420/)
    assert.doesNotMatch(msg, /049f6f2f/)
    assert.doesNotMatch(msg, /e6239657/)
  })

  test('cancelamento (issue #9) troca o título e mantém os campos', () => {
    const msg = formatCheckinMessage(
      normalizeCheckin({
        guest_name: 'Fulano de Tal',
        guest_phone: '+55 11 94863 6475',
        property_name: 'Chalé 01',
        check_in: '26/10/2026',
        check_out: '28/10/2026',
        guests: '2',
        channel: 'booking',
        status: 'cancelled',
        cancellation_reason: 'Cancelado pelo hóspede',
        booking_uuid: '049f6f2f-fa2b-4011-93ab-e3cd0ca7e347',
      }),
    )

    assert.equal(
      msg,
      [
        '❌ *Cancelamento de Reserva*',
        '',
        '🏠 Chalé 01',
        '📅 26/10/2026 → 28/10/2026',
        '👤 Fulano de Tal',
        '👥 2 hóspedes',
        '🌐 Booking',
        '☎️ +55 11 94863 6475',
      ].join('\n'),
    )
  })

  test('grafias de cancelamento e o motivo isolado', () => {
    const comStatus = (status: string) =>
      formatCheckinMessage(normalizeCheckin({ guest_name: 'Ana', status }))

    for (const s of ['cancelled', 'canceled', 'Cancelado', 'CANCELADA', ' cancelled ']) {
      assert.match(comStatus(s), /❌ \*Cancelamento de Reserva\*/, `status: ${s}`)
    }
    for (const s of ['confirmed', 'pending', '']) {
      assert.match(comStatus(s), /✅ \*Nova Reserva Realizada\*/, `status: ${s}`)
    }

    // Motivo preenchido basta, mesmo com status que não conhecemos.
    assert.match(
      formatCheckinMessage(
        normalizeCheckin({ guest_name: 'Ana', status: 'xpto', cancellation_reason: 'No-show' }),
      ),
      /❌ \*Cancelamento de Reserva\*/,
    )
    // `cancellation_reason` vazio não pode virar cancelamento.
    assert.match(
      formatCheckinMessage(
        normalizeCheckin({ guest_name: 'Ana', status: 'confirmed', cancellation_reason: '' }),
      ),
      /✅ \*Nova Reserva Realizada\*/,
    )
  })

  test('o motivo do cancelamento não vai para o grupo', () => {
    const msg = formatCheckinMessage(
      normalizeCheckin({ guest_name: 'Ana', status: 'cancelled', cancellation_reason: 'Motivo sigiloso' }),
    )
    assert.doesNotMatch(msg, /Motivo sigiloso/)
  })

  test('canal em minúscula sai capitalizado', () => {
    assert.match(formatCheckinMessage(normalizeCheckin({ channel: 'booking' })), /🌐 Booking/)
    assert.match(formatCheckinMessage(normalizeCheckin({ channel: 'Airbnb' })), /🌐 Airbnb/)
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

  test('avisa quando o formato não foi reconhecido', () => {
    const msg = formatCheckinMessage(normalizeCheckin({ foo: 'bar' }))
    assert.match(msg, /⚠️ _Formato não reconhecido/)
    assert.match(msg, /GET \/events/)
  })

  test('o aviso de formato desconhecido não deixa linha em branco sobrando', () => {
    const linhas = formatCheckinMessage(normalizeCheckin({ foo: 'bar' })).split('\n')
    // cabeçalho, separador, aviso, ponteiro para /events — nada a mais.
    assert.equal(linhas.length, 4)
    assert.equal(linhas[2]?.startsWith('⚠️'), true)
  })

  test('não avisa quando algum campo-âncora foi reconhecido', () => {
    const msg = formatCheckinMessage(normalizeCheckin({ guest_name: 'Ana' }))
    assert.doesNotMatch(msg, /não reconhecido/)
  })

  test('o payload cru não vai mais anexado na mensagem', () => {
    const msg = formatCheckinMessage(normalizeCheckin({ id: 'RES-9', nested: { a: 1 } }))
    assert.doesNotMatch(msg, /_payload:_/)
    assert.doesNotMatch(msg, /```/)
    assert.doesNotMatch(msg, /RES-9/)
  })

  test('payload gigante não infla a mensagem', () => {
    const raw = { itens: Array.from({ length: 500 }, (_, i) => `item-${i}`) }
    const msg = formatCheckinMessage(normalizeCheckin(raw))
    // Antes o JSON cru ia junto e precisava ser truncado em 1500 caracteres;
    // agora o tamanho não depende mais do payload.
    assert.ok(JSON.stringify(raw).length > 1500)
    assert.ok(msg.length < 300, `mensagem ficou com ${msg.length} caracteres`)
    assert.doesNotMatch(msg, /truncado/)
  })

  test('payload null vira mensagem, não exceção', () => {
    const msg = formatCheckinMessage(normalizeCheckin(null))
    assert.match(msg, /✅ \*Nova Reserva Realizada\*/)
  })

  test('raw undefined vira mensagem, não exceção', () => {
    // Antes isto estourava: JSON.stringify(undefined) devolve undefined e a
    // truncagem quebrava em `text.length`. Sem o bloco de payload, não há mais
    // como chegar lá.
    const msg = formatCheckinMessage({ raw: undefined })
    assert.match(msg, /✅ \*Nova Reserva Realizada\*/)
  })
})
