import { isUnmapped, type CheckinEvent } from './checkin.js'

const RAW_LIMIT = 1500

/** ISO ou yyyy-mm-dd → dd/mm/aaaa. Qualquer outro formato passa intacto. */
function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return value
  const [, year, month, day] = match
  return `${day}/${month}/${year}`
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncado)`
}

export function formatCheckinMessage(evt: CheckinEvent): string {
  const lines: string[] = ['✅ *Check-in realizado*', '']

  if (evt.hospede) lines.push(`👤 ${evt.hospede}`)
  if (evt.imovel) lines.push(`🏠 ${evt.imovel}`)

  const checkIn = formatDate(evt.checkIn)
  const checkOut = formatDate(evt.checkOut)
  if (checkIn && checkOut) lines.push(`📅 ${checkIn} → ${checkOut}`)
  else if (checkIn) lines.push(`📅 ${checkIn}`)

  if (evt.hospedes !== undefined) {
    lines.push(`👥 ${evt.hospedes} ${evt.hospedes === 1 ? 'hóspede' : 'hóspedes'}`)
  }
  if (evt.codigo) lines.push(`🔖 ${evt.codigo}`)
  if (evt.canal) lines.push(`🌐 ${evt.canal}`)

  if (isUnmapped(evt)) {
    lines.push('⚠️ _Payload ainda não mapeado — campos conhecidos não encontrados._')
  }

  // Enquanto o payload não está mapeado, anexar o JSON cru é o que permite
  // descobrir o formato real do provedor direto no grupo. Remover na refatoração.
  const rawJson = JSON.stringify(evt.raw, null, 2)
  lines.push('', '_payload:_', '```', truncate(rawJson, RAW_LIMIT), '```')

  return lines.join('\n')
}
