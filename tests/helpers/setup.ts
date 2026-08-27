/**
 * Precisa ser o PRIMEIRO import de qualquer teste que toque em `src/`.
 *
 * `config/env.ts` valida o ambiente e chama `process.exit(1)` no momento do
 * import; `db/index.ts` abre o SQLite e cria as tabelas também no import. As
 * variáveis têm que existir antes disso — por isso este módulo não importa
 * nada de `src/` (imports são avaliados antes do corpo do módulo).
 *
 * Cada arquivo de teste roda em um processo próprio (`node --test`), então
 * cada um ganha seu próprio banco temporário e não disputa estado com os outros.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TEST_SECRET = 'segredo-de-teste-32-chars'
export const TEST_GROUP_JID = '1234567890-1234567890@g.us'

const dir = mkdtempSync(join(tmpdir(), 'checkin-test-'))

process.env.WEBHOOK_SECRET = TEST_SECRET
process.env.DB_PATH = join(dir, 'app.db')
process.env.AUTH_DIR = join(dir, 'auth_info')
process.env.LOG_LEVEL = 'fatal'
// Fora de produção o logger usa o transport pino-pretty, que sobe uma worker
// thread e segura o processo de teste no fim da execução.
process.env.NODE_ENV = 'production'

// O JID é opcional no boot: os testes que precisam dele ligam via `env`.
delete process.env.WHATSAPP_GROUP_JID

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
