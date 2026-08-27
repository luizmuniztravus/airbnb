import { getSocket, isConnected } from './client.js'

export class NotConnectedError extends Error {
  constructor(){ super('WhatsApp não está conectado'); this.name = 'NotConnectedError' }
}

/** Envia texto para um JID de grupo (`...@g.us`) ou individual. */
export async function sendText(jid: string, text: string): Promise<string | undefined> {
  if (!isConnected()) throw new NotConnectedError()
  const result = await getSocket().sendMessage(jid, { text })
  return result?.key?.id ?? undefined
}

export type GroupSummary = { jid: string; subject: string; participants: number }

/** Lista os grupos de que o número pareado participa — usado para achar o JID. */
export async function listGroups(): Promise<GroupSummary[]> {
  if (!isConnected()) throw new NotConnectedError()
  const groups = await getSocket().groupFetchAllParticipating()
  return Object.values(groups)
    .map((g) => ({
      jid: g.id,
      subject: g.subject ?? '(sem nome)',
      participants: g.participants?.length ?? 0,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'))
}
