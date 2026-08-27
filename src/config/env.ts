import { z } from 'zod'
import { existsSync } from 'node:fs'

// Node 24 carrega .env nativamente — sem dotenv. Variáveis já definidas no
// ambiente (PM2, systemd) têm precedência e não são sobrescritas.
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),

  // `pretty` deixa `pm2 logs` legível; `json` é para quando a saída for coletada
  // por um agregador (Loki, Datadog...). Cores só saem se houver TTY.
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  // Token exigido no header `x-webhook-token`.
  WEBHOOK_SECRET: z.string().min(8, 'WEBHOOK_SECRET precisa ter ao menos 8 caracteres'),

  // Opcional no boot: permite subir o serviço, parear o QR e descobrir o JID
  // via GET /whatsapp/groups antes de preencher.
  WHATSAPP_GROUP_JID: z
    .string()
    .regex(/@g\.us$/, 'WHATSAPP_GROUP_JID deve terminar em @g.us')
    .optional(),

  AUTH_DIR: z.string().default('./data/auth_info'),
  DB_PATH: z.string().default('./data/app.db'),
})

function load() {
  // String vazia no .env deve valer como "não definido".
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
  )

  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    console.error(`Configuração inválida:\n${issues}\n\nVeja .env.example`)
    process.exit(1)
  }
  return result.data
}

export const env = load()
export type Env = typeof env
