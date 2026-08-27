import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../config/env.js'

const expected = Buffer.from(env.WEBHOOK_SECRET)

/** Comparação em tempo constante — não vaza o segredo pelo tempo de resposta. */
function tokenMatches(received: string): boolean {
  const got = Buffer.from(received)
  if (got.length !== expected.length) return false
  return timingSafeEqual(got, expected)
}

/**
 * Exige `x-webhook-token` (ou `Authorization: Bearer <token>`, caso o provedor
 * do webhook só ofereça esse formato).
 */
export async function requireToken(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers['x-webhook-token']
  const auth = req.headers.authorization

  const token =
    (typeof header === 'string' ? header : undefined) ??
    (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined)

  if (!token || !tokenMatches(token)) {
    req.log.warn({ ip: req.ip, path: req.url }, 'token inválido ou ausente')
    return reply.code(401).send({ error: 'unauthorized' })
  }
}
