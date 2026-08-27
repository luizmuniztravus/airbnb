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

## Deploy na VPS (pm2)

```bash
npm ci
npm run build
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save          # persiste a lista de apps
pm2 startup       # gera o serviço systemd para subir no boot (rode o comando que ele imprimir)
```

O `ecosystem.config.cjs` fixa três coisas que não são opcionais:

- **`instances: 1` / `exec_mode: 'fork'`** — o Baileys mantém **uma** sessão do WhatsApp Web. Uma segunda instância com as mesmas credenciais derruba a primeira; em `cluster` o serviço entraria em loop de desconexão.
- **`kill_timeout: 10000`** — o encerramento fecha HTTP, socket do WhatsApp e SQLite. O padrão do pm2 (1,6 s) mata no meio disso.
- **`watch: false`** — `data/` muda a cada mensagem (sessão + WAL do SQLite) e reiniciaria o processo sem parar.

Variáveis de ambiente continuam vindo do `.env` da máquina. O bloco `env` do ecosystem define só `NODE_ENV`: o que estiver ali **tem precedência** sobre o `.env` (`process.loadEnvFile` não sobrescreve o ambiente), então duplicar `LOG_LEVEL` lá faria a edição do `.env` parecer não ter efeito.

### Primeiro pareamento sob pm2

Não há terminal para o QR. O log avisa e a string fica em:

```bash
curl -H "x-webhook-token: SEU_SEGREDO" localhost:3000/whatsapp/status | jq -r .qr
```

Gere a imagem em qualquer leitor de QR a partir dessa string (ex.: `qrencode -t ansiutf8 "$(...)"`).

## Logs

Uma linha por evento, com timestamp ISO carimbado pelo próprio processo (por isso `time: false` no pm2 — o prefixo dele seria duplicado).

| Variável | Valores | Efeito |
|---|---|---|
| `LOG_LEVEL` | `trace`…`fatal`, `silent` | `debug` inclui `/health` e o log interno do Baileys |
| `LOG_FORMAT` | `pretty` (padrão) / `json` | `pretty` para ler com `pm2 logs`; `json` para agregador |

```bash
pm2 logs checkin-notifier            # ao vivo
pm2 logs checkin-notifier --lines 200
grep '"level":50' logs/out.log       # só erros, quando LOG_FORMAT=json
```

O que cada nível significa aqui:

- **`warn`** — precisa de atenção mas o serviço se recupera sozinho: token inválido, conexão do WhatsApp caiu, envio reagendado, payload sem campos reconhecidos.
- **`error`** — algo ficou para trás: falha definitiva de envio (as 6 tentativas acabaram, a mensagem **não** vai chegar ao grupo), sessão deslogada no celular, 5xx numa rota.
- **`fatal`** — o processo vai morrer e o pm2 reiniciar.

Detalhes que ajudam no diagnóstico remoto:

- **Fila parada aparece no log.** Com o WhatsApp desconectado e mensagens pendentes, sai um `warn` a cada ~1 min com quantas esperam e há quanto tempo — sem isso a desconexão longa seria silenciosa.
- **Motivo da desconexão vem por nome**, não só pelo código (`loggedOut`, `restartRequired`, `connectionReplaced`…), junto de quanto tempo a conexão durou.
- **Boot registra a configuração efetiva** (porta, nível de log, caminhos, se o grupo está configurado) e o estado da fila herdada do processo anterior.
- **`x-webhook-token`, `Authorization` e `WEBHOOK_SECRET` são redigidos** antes de escrever. Os arquivos do pm2 ficam em disco na VPS; o token chega em todo request e vazaria junto com os headers.

### Rotação

O pm2 não rotaciona nada sozinho — sem isto `logs/out.log` cresce até encher o disco:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## Docker

```bash
docker build -t checkin-notifier .
docker run -d --name checkin -p 3000:3000 --env-file .env \
  -v checkin-data:/app/data checkin-notifier
docker logs -f checkin   # o QR do primeiro pareamento aparece aqui
```

O volume em `/app/data` é obrigatório: sem ele, a sessão do WhatsApp e o banco se perdem a cada restart.
