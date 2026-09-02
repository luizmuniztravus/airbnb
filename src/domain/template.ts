import { isCancelamento, isUnmapped, type CheckinEvent } from './checkin.js'

/** ISO ou yyyy-mm-dd → dd/mm/aaaa. Qualquer outro formato passa intacto. */
function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return value
  const [, year, month, day] = match
  return `${day}/${month}/${year}`
}

/** `booking` → `Booking`. O provedor manda o canal em minúscula. */
function capitalizar(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function formatCheckinMessage(evt: CheckinEvent): string {
  // Mesmo webhook, dois eventos: o título é o que separa um do outro no grupo.
  const titulo = isCancelamento(evt)
    ? '❌ *Cancelamento de Reserva*'
    : '✅ *Nova Reserva Realizada*'

  const cabecalho = [titulo, '']
  const lines: string[] = []

  if (evt.imovel) lines.push(`🏠 ${evt.imovel}`)

  const checkIn = formatDate(evt.checkIn)
  const checkOut = formatDate(evt.checkOut)
  if (checkIn && checkOut) lines.push(`📅 ${checkIn} → ${checkOut}`)
  else if (checkIn) lines.push(`📅 ${checkIn}`)

  if (evt.hospede) lines.push(`👤 ${evt.hospede}`)

  if (evt.hospedes !== undefined) {
    lines.push(`👥 ${evt.hospedes} ${evt.hospedes === 1 ? 'hóspede' : 'hóspedes'}`)
  }
  if (evt.canal) lines.push(`🌐 ${capitalizar(evt.canal)}`)
  if (evt.telefone) lines.push(`☎️ ${evt.telefone}`)

  // Sem o JSON cru anexado, esta linha passa a ser o único sinal no grupo de
  // que chegou um formato desconhecido — o payload continua inteiro no banco.
  if (isUnmapped(evt)) {
    // Só separa do que veio acima se houver algo acima: num payload totalmente
    // desconhecido a lista está vazia e a linha em branco sobraria.
    if (lines.length > 0) lines.push('')
    lines.push(
      '⚠️ _Formato não reconhecido: nenhum campo conhecido foi encontrado._',
      '_O payload está salvo — veja `GET /events`._',
    )
  }

  return [...cabecalho, ...lines].join('\n')
}
