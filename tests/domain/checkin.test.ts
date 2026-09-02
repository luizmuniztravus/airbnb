import '../helpers/setup.js'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCheckin, isUnmapped } from '../../src/domain/checkin.js'

describe('normalizeCheckin', () => {
  test('extrai o payload canônico do README', () => {
    const evt = normalizeCheckin({
      id: 'RES-001',
      guest: { name: 'João Silva' },
      listing: { name: 'Apto 302' },
      check_in: '2026-08-27',
      check_out: '2026-08-30',
      guests: 2,
    })

    assert.equal(evt.hospede, 'João Silva')
    assert.equal(evt.imovel, 'Apto 302')
    assert.equal(evt.checkIn, '2026-08-27')
    assert.equal(evt.checkOut, '2026-08-30')
    assert.equal(evt.hospedes, 2)
    assert.equal(evt.codigo, 'RES-001')
    assert.equal(evt.canal, undefined)
  })

  test('aceita os nomes em português', () => {
    const evt = normalizeCheckin({
      hospede: { nome: 'Maria' },
      imovel: 'Casa da Praia',
      data_checkin: '2026-09-01',
      data_checkout: '2026-09-05',
      num_hospedes: 4,
      codigo: 'ABC123',
      origem: 'Booking',
    })

    assert.equal(evt.hospede, 'Maria')
    assert.equal(evt.imovel, 'Casa da Praia')
    assert.equal(evt.checkIn, '2026-09-01')
    assert.equal(evt.checkOut, '2026-09-05')
    assert.equal(evt.hospedes, 4)
    assert.equal(evt.codigo, 'ABC123')
    assert.equal(evt.canal, 'Booking')
  })

  test('extrai o payload real do provedor', () => {
    // Fixture capturada em produção (dados trocados por fictícios). Antes de
    // `property_name`, `guest_phone` e `booking_uuid` entrarem nas listas, o
    // imóvel, o telefone e o código saíam como undefined.
    const evt = normalizeCheckin({
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
      booking_uuid: '049f6f2f-fa2b-4011-93ab-e3cd0ca7e347',
      property_uuid: 'e6239657-2817-4c41-82c0-2b52b069bfa9',
      _workflow_id: 38,
      _workflow_execution_id: 968,
    })

    assert.equal(evt.hospede, 'Fulano de Tal')
    assert.equal(evt.imovel, 'Chalé 01')
    assert.equal(evt.checkIn, '26/10/2026')
    assert.equal(evt.checkOut, '28/10/2026')
    // Vem como texto no payload e é convertido para número.
    assert.equal(evt.hospedes, 2)
    assert.equal(evt.telefone, '+55 11 94863 6475')
    assert.equal(evt.codigo, '049f6f2f-fa2b-4011-93ab-e3cd0ca7e347')
    assert.equal(evt.canal, 'booking')
    assert.equal(isUnmapped(evt), false)
  })

  test('telefone é lido dos nomes alternativos', () => {
    assert.equal(normalizeCheckin({ guest: { phone: '+5511900000000' } }).telefone, '+5511900000000')
    assert.equal(normalizeCheckin({ celular: '11 90000-0000' }).telefone, '11 90000-0000')
    assert.equal(normalizeCheckin({ guest_name: 'Ana' }).telefone, undefined)
  })

  test('lê caminhos aninhados (dates.start / dates.end)', () => {
    const evt = normalizeCheckin({ dates: { start: '2026-01-10', end: '2026-01-12' } })
    assert.equal(evt.checkIn, '2026-01-10')
    assert.equal(evt.checkOut, '2026-01-12')
  })

  test('respeita a ordem de prioridade dos caminhos', () => {
    // 'guest.name' vem antes de 'guest_name', que vem antes de 'name'.
    const evt = normalizeCheckin({
      guest: { name: 'primeiro' },
      guest_name: 'segundo',
      name: 'terceiro',
    })
    assert.equal(evt.hospede, 'primeiro')
  })

  test('pula caminho vazio e cai no próximo', () => {
    const evt = normalizeCheckin({ guest: { name: '   ' }, guest_name: 'Fallback' })
    assert.equal(evt.hospede, 'Fallback')
  })

  test('faz trim das strings', () => {
    const evt = normalizeCheckin({ guest_name: '  Ana Paula  ' })
    assert.equal(evt.hospede, 'Ana Paula')
  })

  test('converte número para string em campos textuais', () => {
    const evt = normalizeCheckin({ id: 987654 })
    assert.equal(evt.codigo, '987654')
  })

  test('converte string numérica em campos numéricos', () => {
    const evt = normalizeCheckin({ guests: '3' })
    assert.equal(evt.hospedes, 3)
  })

  test('ignora número não finito e string não numérica', () => {
    assert.equal(normalizeCheckin({ guests: 'muitos' }).hospedes, undefined)
    assert.equal(normalizeCheckin({ guests: Number.NaN }).hospedes, undefined)
    assert.equal(normalizeCheckin({ guests: Number.POSITIVE_INFINITY }).hospedes, undefined)
  })

  test('aceita zero hóspedes (0 é valor válido, não ausência)', () => {
    assert.equal(normalizeCheckin({ guests: 0 }).hospedes, 0)
  })

  test('não estoura em nós ausentes ou de tipo inesperado', () => {
    assert.equal(normalizeCheckin({ guest: null }).hospede, undefined)
    assert.equal(normalizeCheckin({ guest: 'texto' }).hospede, undefined)
    assert.equal(normalizeCheckin({ listing: [] }).imovel, undefined)
  })

  test('aceita payloads que não são objeto', () => {
    for (const raw of [null, undefined, 42, 'texto', []]) {
      const evt = normalizeCheckin(raw)
      assert.equal(evt.hospede, undefined)
      assert.equal(evt.checkIn, undefined)
      assert.deepEqual(evt.raw, raw)
    }
  })

  test('preserva o payload cru por referência', () => {
    const raw = { qualquer: { coisa: [1, 2, 3] } }
    assert.equal(normalizeCheckin(raw).raw, raw)
  })
})

describe('isUnmapped', () => {
  test('true quando nenhum dos quatro campos-âncora foi reconhecido', () => {
    assert.equal(isUnmapped(normalizeCheckin({ foo: 'bar' })), true)
  })

  test('true mesmo com código e canal — eles não contam como mapeamento', () => {
    const evt = normalizeCheckin({ id: 'RES-1', channel: 'Airbnb', guests: 2 })
    assert.equal(evt.codigo, 'RES-1')
    assert.equal(isUnmapped(evt), true)
  })

  test('false quando qualquer campo-âncora aparece', () => {
    assert.equal(isUnmapped(normalizeCheckin({ guest_name: 'Ana' })), false)
    assert.equal(isUnmapped(normalizeCheckin({ property: 'Apto 1' })), false)
    assert.equal(isUnmapped(normalizeCheckin({ check_in: '2026-01-01' })), false)
    assert.equal(isUnmapped(normalizeCheckin({ check_out: '2026-01-02' })), false)
  })
})
