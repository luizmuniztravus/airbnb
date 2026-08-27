// Configuração do PM2.
// Extensão .cjs porque o package.json declara "type": "module" e o PM2 carrega
// o ecosystem com require().
const { join } = require('node:path')

module.exports = {
  apps: [
    {
      name: 'checkin-notifier',
      script: 'dist/index.js',

      // src/config/env.ts lê `.env` e DB_PATH/AUTH_DIR são caminhos relativos —
      // tudo depende do cwd ser a raiz do projeto, mesmo que o `pm2 start`
      // seja disparado de outro diretório.
      cwd: __dirname,

      // NÃO trocar para cluster nem aumentar `instances`. Existe uma única
      // sessão do Baileys em AUTH_DIR: duas conexões no mesmo pareamento
      // derrubam uma à outra. E o worker do outbox é um setInterval por
      // processo — com N instâncias a mesma mensagem sairia N vezes no grupo.
      exec_mode: 'fork',
      instances: 1,

      // Só o mínimo aqui: variável definida neste bloco tem precedência sobre o
      // `.env` (`process.loadEnvFile` não sobrescreve o ambiente), então um
      // LOG_LEVEL/LOG_FORMAT duplicado faria a edição do `.env` parecer não ter
      // efeito. Os segredos também continuam só no `.env` — o ecosystem é
      // versionado.
      env: {
        NODE_ENV: 'production',
      },

      autorestart: true,
      restart_delay: 5_000,
      // Se o boot falhar por configuração inválida, env.ts chama process.exit(1).
      // Sem esse limite o PM2 ficaria reiniciando em loop para sempre.
      min_uptime: '30s',
      max_restarts: 10,

      // O shutdown fecha o Fastify, encerra o socket do Baileys e o banco antes
      // de sair. O padrão do PM2 (1,6s) mata no meio disso.
      kill_timeout: 15_000,

      // Rede de segurança para vazamento de memória em execuções longas.
      max_memory_restart: '500M',

      // Não observar arquivos: `data/` muda a cada mensagem (sessão do Baileys
      // + WAL do SQLite) e reiniciaria o processo sem parar.
      watch: false,

      out_file: join(__dirname, 'logs/out.log'),
      error_file: join(__dirname, 'logs/error.log'),
      merge_logs: true,
      // O pino já carimba o timestamp ISO em cada linha; o prefixo do PM2 só
      // duplicaria — e quebraria o JSON quando LOG_FORMAT=json.
      time: false,
    },
  ],
}
