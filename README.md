# Notificador de Check-in via WhatsApp

Recebe um webhook de reserva/check-in e publica uma mensagem em um **grupo do WhatsApp**.

```
App web ──POST /webhooks/nova-reserva──► API ──► SQLite (events + outbox) ──► Baileys ──► grupo @g.us
                                          │
                                    responde 200 na hora
```

## Por que Baileys

A **WhatsApp Cloud API oficial da Meta não envia mensagens para grupos**, apenas para conversas individuais. Publicar em grupo exige uma solução baseada em WhatsApp Web — aqui, [Baileys](https://github.com/WhiskeySockets/Baileys) embutido no próprio serviço.

> ⚠️ **Use um chip dedicado.** Baileys é não-oficial; o número pareado pode ser bloqueado pela Meta. Nunca pareie o número pessoal ou o principal da operação.

Versão fixada em `baileys@6.7.24` (dist-tag `legacy`). A `7.0.0-rc*` ainda é release candidate, com quedas silenciosas de conexão relatadas.

## Setup

```bash
npm install
cp .env.example .env
# edite .env: defina ao menos WEBHOOK_SECRET (openssl rand -hex 32)
npm run dev
```

### Primeiro pareamento

1. Suba o serviço. Um **QR code aparece no terminal**.
2. No celular do chip dedicado: WhatsApp → Configurações → Dispositivos conectados → Conectar dispositivo.
3. Escaneie. O log confirma `conexão aberta`.

Sem acesso ao terminal, `GET /whatsapp/status` devolve a string do QR.

A sessão fica em `data/auth_info/` e sobrevive a restarts — o QR só reaparece se você desconectar o dispositivo pelo celular.

### Descobrir o JID do grupo

```bash
curl -H "x-webhook-token: SEU_SEGREDO" localhost:3000/whatsapp/groups
```

Copie o `jid` do grupo desejado (formato `1234567890-1234567890@g.us`) para `WHATSAPP_GROUP_JID` no `.env` e reinicie.

## Endpoints

Todos exigem o header `x-webhook-token: <WEBHOOK_SECRET>` (ou `Authorization: Bearer <token>`), exceto `/health`.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/webhooks/nova-reserva` | Recebe o webhook. Aceita qualquer JSON. |
| `GET` | `/health` | Estado do serviço, da conexão e do outbox. Público. |
| `GET` | `/whatsapp/status` | Estado da conexão + QR pendente. |
| `GET` | `/whatsapp/groups` | Lista os grupos e seus JIDs. |
| `POST` | `/whatsapp/test` | Envia mensagem de teste ao grupo configurado. |
| `GET` | `/events?limit=20` | Payloads já recebidos (para mapear os campos reais). |

### Exemplo

```bash
curl -X POST localhost:3000/webhooks/nova-reserva \
  -H "content-type: application/json" \
  -H "x-webhook-token: SEU_SEGREDO" \
  -d '{"id":"RES-001","guest":{"name":"João Silva"},"listing":{"name":"Apto 302"},
       "check_in":"2026-08-27","check_out":"2026-08-30","guests":2}'
```

Respostas possíveis: `queued` (enfileirado), `duplicate` (já recebido), `stored_no_target` (salvo, mas `WHATSAPP_GROUP_JID` não configurado).

## Garantias

- **Resposta imediata** — o provedor nunca espera o WhatsApp. Se o socket estiver caído, a mensagem fica no outbox e sai quando a conexão voltar.
- **Idempotência** — reenvios do provedor não duplicam a mensagem no grupo. A chave vem de `id`/`reservation_id`/`booking_id`/… ou, na falta deles, do SHA-256 do payload.
- **Retry com backoff** — 6 tentativas (5s, 15s, 45s, …) antes de marcar `failed`.
- **Payload sempre preservado** — todo webhook é gravado cru na tabela `events`, mesmo que nenhum campo seja reconhecido.

## Mapeando o payload real

`src/domain/checkin.ts` é o **único** arquivo a mudar. Hoje ele procura cada campo em vários nomes possíveis e aceita não achar nada; a mensagem enviada anexa o JSON cru justamente para revelar o formato do provedor.

Quando o formato estabilizar:

1. Colete exemplos reais: `curl -H "x-webhook-token: ..." localhost:3000/events`
2. Reescreva `normalizeCheckin` com um parse estrito (zod) usando esses exemplos como fixtures.
3. Remova o bloco `_payload:_` de `src/domain/template.ts`.

## Produção com PM2

```bash
npm install -g pm2
npm ci
cp .env.example .env   # preencha WEBHOOK_SECRET
npm run pm2:start      # compila e sobe o processo
npm run pm2:logs       # o QR do primeiro pareamento aparece aqui
```

Sobreviver ao reboot da máquina:

```bash
pm2 save
pm2 startup   # execute o comando que ele imprimir (usa sudo)
```

| Comando | O que faz |
|---|---|
| `npm run pm2:start` | `npm run build` + `pm2 start` |
| `npm run pm2:restart` | rebuild e reinicia relendo o `.env` |
| `npm run pm2:stop` | para o processo (mantém na lista do PM2) |
| `npm run pm2:logs` | acompanha os logs |
| `pm2 status` | estado, uptime, restarts |

Configuração em [`ecosystem.config.cjs`](ecosystem.config.cjs). Dois pontos que não são detalhe:

- **`instances: 1` e `exec_mode: 'fork'`.** Não coloque em cluster. Só existe uma sessão do Baileys em `AUTH_DIR`, e duas conexões no mesmo pareamento derrubam uma à outra; além disso o worker do outbox é um `setInterval` por processo, então N instâncias mandariam a mesma mensagem N vezes no grupo.
- **`kill_timeout: 15000`.** O encerramento fecha o Fastify, o socket do WhatsApp e o banco. O padrão do PM2 (1,6s) mata no meio.

Os segredos ficam no `.env`, lido pelo próprio app (`process.loadEnvFile`) — o `ecosystem.config.cjs` é versionado e não deve conter nada sensível. Como o app resolve `.env`, `data/` e `dist/` a partir do cwd, o ecosystem fixa `cwd: __dirname`.

Logs vão para `logs/out.log` e `logs/error.log` (gitignorados). Para rotacioná-los:

```bash
pm2 install pm2-logrotate
```

### Diretório `data/`

`data/auth_info/` (credenciais do número pareado) e `data/app.db` (eventos + outbox) precisam persistir entre restarts — sem eles o QR volta a cada boot. Faça backup desse diretório e **nunca** o versione.
