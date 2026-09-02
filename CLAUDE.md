# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

O projeto é escrito em português — comentários, logs, mensagens de commit e documentação. Mantenha esse padrão.

## Comandos

```bash
npm run dev             # tsx watch, recarrega a cada alteração
npm run typecheck       # tsc --noEmit — rode antes de considerar qualquer mudança pronta
npm test                # suíte completa (node:test + tsx)
npm run test:watch      # re-roda ao salvar
npm run typecheck:tests # checa tipos incluindo tests/
npm run build           # gera dist/
npm start               # roda dist/ (produção)
```

Antes de considerar qualquer mudança pronta: `npm run typecheck` **e** `npm test`. Não há linter.

Os testes usam o runner nativo do Node — sem framework. Cada arquivo roda em processo próprio, com SQLite temporário criado por `tests/helpers/setup.ts`, que **precisa ser o primeiro import**: `config/env.ts` valida o ambiente (e faz `process.exit(1)` se faltar variável) e `db/index.ts` abre o banco já no momento do import. O teste do worker troca `whatsapp/client.ts` e `whatsapp/sender.ts` por dublês via `mock.module` — daí a flag `--experimental-test-module-mocks` no script. Nenhum teste abre socket nem fala com o WhatsApp.

A CI (`.github/workflows/ci.yml`) roda typecheck e build em Node 22 e 24, mais um job que barra `.env`/`data/` versionados e o baileys fora do 6.7.24.

**A suíte só roda no Node 24.** No 22 o `mock.module` não expõe os named exports do dublê para quem importa estaticamente, e `src/whatsapp/outbox.ts` importa `getStatus`/`isConnected` de `./client.js` assim — o arquivo do worker nem carrega. Isso é limitação do dublê, não da aplicação: no 22 o typecheck e o build passam e 80 dos 82 testes rodam, e por isso `engines` continua em `>=22`. Se for preciso rodar a suíte no 22, o caminho é trocar `mock.module` por injeção de dependência em `startOutboxWorker` — não mexer no especificador do mock, que já foi testado e não resolve.

Complementando, o fluxo manual de `curl` do README continua válido para checar o contrato ponta a ponta (webhook → `queued` → `duplicate` no reenvio).

Endpoints exigem `x-webhook-token: <WEBHOOK_SECRET>`, exceto `/health`.
Para inspecionar a fila diretamente: `sqlite3 data/app.db 'SELECT id,status,attempts FROM outbox'`.

## Arquitetura

```
webhook → grava em `events` → responde 200 → enfileira em `outbox` → worker → Baileys → grupo
```

O ponto central é que **a resposta HTTP e o envio do WhatsApp são desacoplados**. O socket do Baileys pode estar reconectando quando o webhook chega, e o provedor não pode esperar por isso. O handler em `src/routes/webhook.ts` nunca chama o WhatsApp; ele só enfileira. Quem entrega é o worker de `src/whatsapp/outbox.ts`, num `setInterval` que **pula o ciclo inteiro quando `isConnected()` é falso** — assim uma desconexão não consome tentativas de retry.

Consequência para quem for mexer: não adicione envio síncrono no caminho do webhook, mesmo que pareça mais simples.

### Idempotência

`dedupe_key` vem do primeiro campo de id encontrado no payload (`id`, `reservation_id`, `booking_id`…) ou, na falta deles, do SHA-256 do corpo. Provedores de webhook reenviam, e sem isso o grupo receberia a mensagem duas vezes.

A sutileza: um evento repetido só é rejeitado se **já gerou mensagem** (`hasMessageForEvent`). Sem essa checagem, eventos gravados antes de `WHATSAPP_GROUP_JID` existir ficariam presos como duplicados para sempre e nunca seriam enviados — exatamente na janela de setup inicial. Não simplifique isso para um `if (isDuplicate) return`.

### `src/domain/checkin.ts` é o ponto de refatoração

O payload real do provedor ainda não é conhecido. `normalizeCheckin` faz busca tolerante do mesmo campo em vários nomes e aninhamentos (`guest.name`, `hospede.nome`, `guest_name`…), aceita não achar nada, e `template.ts` anexa o JSON cru na mensagem para revelar o formato na prática.

Quando o formato estabilizar: colete exemplos com `GET /events`, troque `normalizeCheckin` por um parse estrito com zod usando-os como fixtures, e remova o bloco `_payload:_` de `template.ts`. **Nada fora desses dois arquivos deve precisar mudar** — se precisar, algo vazou de camada.

## Restrições que não são negociáveis

- **A Cloud API oficial da Meta não envia para grupos**, só para conversas individuais. Por isso o Baileys (WhatsApp Web) está embutido. Não sugira trocar por Cloud API/Twilio enquanto o destino for um grupo.
- **`baileys` está fixado em `6.7.24`** (dist-tag `legacy`). A `7.0.0-rc*` tem quedas silenciosas de conexão relatadas. Não atualize sem verificar se saiu uma estável.
- **O serviço escuta em `127.0.0.1` e fica atrás de um proxy reverso com TLS.** O default de `HOST` em `src/config/env.ts` é `0.0.0.0`; quem fecha isso é a linha `HOST=127.0.0.1` do `.env.example`. Não sugira expor a porta direto: `GET /whatsapp/status` devolve a string do QR — quem a capturar pareia o próprio dispositivo na conta — e o `WEBHOOK_SECRET` viaja em header. `GET /events` devolve os payloads completos das reservas.
- **`data/` é gitignored e contém as credenciais da sessão do WhatsApp** (`data/auth_info/`) além do banco. Nunca versionar, nunca colar conteúdo em logs ou PRs.
- O número pareado é um chip dedicado. Baileys é não-oficial e o número pode ser bloqueado pela Meta.

### Detalhes do Baileys que já causaram problema

- `printQRInTerminal` está deprecado — o QR é tratado no evento `connection.update` (campo `qr`) em `src/whatsapp/client.ts`.
- `creds.update` → `saveCreds` é obrigatório, senão a sessão não persiste e o QR reaparece a cada restart.
- `DisconnectReason.restartRequired` (515) é **esperado** logo após o pareamento e exige reconexão imediata — não confundir com `loggedOut` (401), que invalida as credenciais e exige apagar `AUTH_DIR`.

## Worktrees

O repositório é usado com worktrees em `.claude/worktrees/`, uma sessão do Claude Code por worktree. Cada uma nasce de `origin/main`, então **não enxerga o que foi feito nas outras** até um `git merge main`.

Ao começar numa worktree recém-criada, nada gitignored vem junto:

```bash
npm install                              # node_modules não é compartilhado; better-sqlite3 é nativo
cp /home/joao/Documentos/airbnb/.env .   # inclui o WEBHOOK_SECRET
```

Depois ajuste no `.env` da worktree:

- **`PORT`** — use uma porta diferente (3001, 3002…). Duas instâncias na 3000 e a segunda não sobe.
- **`AUTH_DIR`** — apontar para o `data/auth_info` do diretório principal reaproveita o pareamento, mas **só uma instância pode rodar por vez**: duas conexões na mesma sessão do Baileys derrubam uma à outra. Se as duas precisam rodar simultaneamente, cada uma precisa do próprio número pareado.

Antes de commitar em qualquer worktree, confirme em qual você está (`git worktree list` marca a atual) e que `.env` e `data/` não entraram no stage.
