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

## Testes

```bash
npm test              # suíte completa
npm run test:watch    # re-roda ao salvar
npm run typecheck:tests
```

Runner nativo do Node (`node:test`) + `tsx` — sem framework extra. Cada arquivo roda em seu próprio processo, com um SQLite temporário criado por `tests/helpers/setup.ts` (que precisa ser o primeiro import: `config/env.ts` valida o ambiente e `db/index.ts` abre o banco já no import).

| Arquivo | O que cobre |
|---|---|
| `tests/domain/checkin.test.ts` | Extração tolerante: aliases, aninhamento, coerção, `isUnmapped` |
| `tests/domain/template.test.ts` | Formato da mensagem, datas, plural, truncagem do payload |
| `tests/db/events.test.ts` | Gravação e deduplicação por `dedupe_key` |
| `tests/db/outbox.test.ts` | Fila, backoff (5s → 15s → 45s…), esgotamento em `failed` |
| `tests/routes/auth.test.ts` | `x-webhook-token`, `Bearer`, comparação em tempo constante |
| `tests/routes/webhook.test.ts` | Contrato do webhook: `queued` / `duplicate` / `stored_no_target` |
| `tests/whatsapp/outbox-worker.test.ts` | Worker: envio, retry, e o que acontece com a conexão caída |

O teste do worker troca `whatsapp/client.ts` e `whatsapp/sender.ts` por dublês (`mock.module`, daí a flag `--experimental-test-module-mocks`). Nenhum teste abre socket, toca o Baileys ou fala com o WhatsApp.

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

Numa VPS nova, `scripts/bootstrap-vps.sh` faz tudo isto (e o resto desta seção) de uma vez — veja [Scripts](#scripts).

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

Logs vão para `logs/out.log` e `logs/error.log` (gitignorados) — veja [Logs](#logs).

### Diretório `data/`

`data/auth_info/` (credenciais do número pareado) e `data/app.db` (eventos + outbox) precisam persistir entre restarts — sem eles o QR volta a cada boot. Faça backup desse diretório e **nunca** o versione.

## Scripts

Dois scripts em `scripts/`, ambos para rodar **na própria VPS**.

### `bootstrap-vps.sh` — VPS nova

```bash
sudo ./scripts/bootstrap-vps.sh
```

Faz de uma vez o que a seção anterior descreve manualmente: usuário de sistema dedicado, pacotes de build do `better-sqlite3`, Node, PM2, clone, `npm ci`, build, `.env` com `WEBHOOK_SECRET` gerado, `pm2 startOrReload ecosystem.config.cjs` e `pm2 startup` para sobreviver ao reboot.

É idempotente: reexecutar atualiza o código e recarrega o PM2 **sem tocar em `.env` nem em `data/`** — serve tanto para provisionar quanto para fazer deploy.

Ajustável por variáveis: `APP_USER` (padrão `checkin`), `APP_DIR` (`/opt/checkin-notifier`), `REPO_URL`, `REPO_REF`, `NODE_MAJOR`.

O serviço não roda como root: `data/auth_info/` dá acesso à conta de WhatsApp pareada. Firewall e TLS ficam de fora — o `WEBHOOK_SECRET` viaja em header, então exponha o endpoint por trás de um proxy reverso com HTTPS.

### `whatsapp-qr.sh` — novo pareamento

```bash
sudo -u checkin ./scripts/whatsapp-qr.sh          # mostra o QR pendente
sudo -u checkin ./scripts/whatsapp-qr.sh --reset  # apaga a sessão e força um novo
```

Lê o QR de `GET /whatsapp/status`, não dos logs: o Baileys troca o código a cada ~20s e o endpoint sempre devolve o vigente, então o script redesenha a cada troca e sai sozinho quando o status vira `open`.

Queda normal de sessão (`loggedOut`) já é tratada pelo serviço, que limpa as credenciais e emite um QR novo — nesse caso basta rodar sem flag. O `--reset` é para o serviço travado sem emitir QR; ele recusa apagar qualquer coisa que não esteja dois níveis abaixo da raiz do projeto, o que também protege o `data/` inteiro.

## Logs

Uma linha por evento, com timestamp ISO carimbado pelo próprio processo (por isso `time: false` no ecosystem — o prefixo do PM2 seria duplicado).

| Variável | Valores | Efeito |
|---|---|---|
| `LOG_LEVEL` | `trace`…`fatal`, `silent` | `debug` inclui `/health` e o log interno do Baileys |
| `LOG_FORMAT` | `pretty` (padrão) / `json` | `pretty` para ler com `npm run pm2:logs`; `json` para agregador |

```bash
npm run pm2:logs                     # ao vivo
pm2 logs checkin-notifier --lines 200
grep '"level":50' logs/out.log       # só erros, quando LOG_FORMAT=json
```

O que cada nível significa aqui:

- **`warn`** — precisa de atenção mas o serviço se recupera sozinho: token inválido, conexão do WhatsApp caiu, envio reagendado, payload sem campos reconhecidos.
- **`error`** — algo ficou para trás: falha definitiva de envio (as 6 tentativas acabaram, a mensagem **não** vai chegar ao grupo), sessão deslogada no celular, 5xx numa rota.
- **`fatal`** — o processo vai morrer e o PM2 reiniciar.

Detalhes que ajudam no diagnóstico remoto:

- **Fila parada aparece no log.** Com o WhatsApp desconectado e mensagens pendentes, sai um `warn` a cada ~1 min com quantas esperam e há quanto tempo — sem isso a desconexão longa seria silenciosa.
- **Motivo da desconexão vem por nome**, não só pelo código (`loggedOut`, `restartRequired`, `connectionReplaced`…), junto de quanto tempo a conexão durou.
- **Boot registra a configuração efetiva** (porta, nível de log, caminhos, se o grupo está configurado) e o estado da fila herdada do processo anterior.
- **Uma linha por requisição** (método, url, status, ms, ip, `reqId`), não as duas do log automático do Fastify. `/health` cai para `debug` para o monitoramento não inundar o arquivo.
- **`x-webhook-token`, `Authorization` e `WEBHOOK_SECRET` são redigidos** antes de escrever. Os arquivos do PM2 ficam em disco na VPS; o token chega em todo request e vazaria junto com os headers.

### Rotação

O PM2 não rotaciona nada sozinho — sem isto `logs/out.log` cresce até encher o disco:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```
