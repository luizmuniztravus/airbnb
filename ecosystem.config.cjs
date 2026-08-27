// Configuração do pm2 para a VPS.  `.cjs` porque o package.json é "type": "module".
//
//   npm run build && pm2 start ecosystem.config.cjs && pm2 save
//
const { join } = require('node:path')

module.exports = {
  apps: [
    {
      name: 'checkin-notifier',
      script: 'dist/index.js',
      cwd: __dirname,

      // NUNCA mais de uma instância: o Baileys mantém UMA sessão do WhatsApp
      // Web, e uma segunda conexão com as mesmas credenciais derruba a primeira.
      // Por isso também não usar `cluster`.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      // Se cair 10 vezes sem completar 30s de pé, é erro de configuração e não
      // queda de rede — o pm2 para e o problema fica visível em `pm2 status`.
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      max_memory_restart: '400M',

      // O shutdown fecha o HTTP, o socket do WhatsApp e o SQLite. O padrão do
      // pm2 (1,6s) mata no meio disso e pode deixar o banco em WAL sujo.
      kill_timeout: 10000,

      // Não observar arquivos: `data/` muda o tempo todo (sessão + SQLite) e
      // reiniciaria o processo em loop.
      watch: false,

      // Absoluto: caminho relativo aqui é resolvido contra o cwd do daemon do
      // pm2, não contra o do projeto.
      out_file: join(__dirname, 'logs/out.log'),
      error_file: join(__dirname, 'logs/error.log'),
      merge_logs: true,
      // O pino já carimba ISO em cada linha; o prefixo do pm2 só duplicaria.
      time: false,

      // Só o mínimo aqui: variável definida neste bloco tem precedência sobre o
      // `.env` (o process.loadEnvFile não sobrescreve o ambiente), e um
      // LOG_LEVEL duplicado faria a edição do `.env` parecer não ter efeito.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
