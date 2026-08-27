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

## Docker

```bash
docker build -t checkin-notifier .
docker run -d --name checkin -p 3000:3000 --env-file .env \
  -v checkin-data:/app/data checkin-notifier
docker logs -f checkin   # o QR do primeiro pareamento aparece aqui
```

O volume em `/app/data` é obrigatório: sem ele, a sessão do WhatsApp e o banco se perdem a cada restart.
