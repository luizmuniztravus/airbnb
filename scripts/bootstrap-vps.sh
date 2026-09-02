#!/usr/bin/env bash
#
# Provisiona uma VPS nova (Debian/Ubuntu) para rodar o notificador de check-in
# sob PM2, do zero até o serviço no ar aguardando o pareamento do QR.
#
#   sudo ./scripts/bootstrap-vps.sh
#
# É idempotente: reexecutar atualiza o código, rebuilda e recarrega o PM2 sem
# tocar em `.env` nem em `data/` (onde ficam a sessão do WhatsApp e o banco).
#
# Variáveis aceitas (todas opcionais):
#   APP_USER=checkin                 usuário de sistema dono da aplicação
#   APP_DIR=/opt/checkin-notifier    onde o código fica
#   REPO_URL=<url ou caminho local>  origem do clone
#   REPO_REF=main                    branch/tag a implantar
#   NODE_MAJOR=24
#   SWAP=1                           cria swap se a RAM for < 2G e não houver
#   SWAP_MB=2048                     tamanho da swap criada
#   UFW=0                            1 = configura o firewall (libera SSH antes)
#   LOGROTATE=1                      instala e configura o pm2-logrotate
set -euo pipefail

APP_USER="${APP_USER:-checkin}"
APP_DIR="${APP_DIR:-/opt/checkin-notifier}"
REPO_URL="${REPO_URL:-https://github.com/luizmuniztravus/airbnb.git}"
REPO_REF="${REPO_REF:-main}"
NODE_MAJOR="${NODE_MAJOR:-24}"
SWAP="${SWAP:-1}"
SWAP_MB="${SWAP_MB:-2048}"
# Desligado por padrão: habilitar firewall numa máquina remota é a forma
# clássica de se trancar do lado de fora. Só com UFW=1, e sempre liberando
# SSH antes de ativar.
UFW="${UFW:-0}"
LOGROTATE="${LOGROTATE:-1}"
# Fixo: quem define o nome do processo é o `apps[].name` do ecosystem.
PM2_APP=checkin-notifier

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
aviso() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
erro() {
  printf '\033[1;31mxx\033[0m %s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || erro "rode como root: sudo $0"
command -v apt-get >/dev/null || erro "este script assume Debian/Ubuntu (apt-get não encontrado)"

# ---------------------------------------------------------------- usuário ----
# Usuário de sistema dedicado: `data/auth_info` guarda credenciais que dão
# acesso à conta de WhatsApp pareada — não é coisa para rodar como root.
if id -u "$APP_USER" >/dev/null 2>&1; then
  info "usuário $APP_USER já existe"
else
  info "criando usuário de sistema $APP_USER"
  # --create-home porque o npm e o PM2 precisam de HOME para cache e daemon.
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
[[ -n $APP_HOME ]] || erro "não consegui descobrir o HOME de $APP_USER"

# `runuser` não troca HOME sozinho; sem isso o npm tentaria escrever em /root/.npm.
como_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" "$@"; }

# -------------------------------------------------------------------- swap ---
# `npm ci` compila o better-sqlite3 do zero: não há binário pronto para o Node
# 24, então o node-gyp roda g++ sobre o sqlite3.c. Numa droplet de 1G sem swap
# isso é candidato a OOM no meio da instalação — e o erro que aparece
# ("Killed") não diz que faltou memória.
ram_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
swap_mb="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
if [[ $SWAP -eq 1 && $ram_mb -lt 2000 && $swap_mb -lt 256 ]]; then
  if [[ -e /swapfile ]]; then
    aviso "/swapfile já existe mas não está ativo — deixando como está"
  else
    info "RAM de ${ram_mb}M sem swap — criando /swapfile de ${SWAP_MB}M"
    # fallocate falha em alguns filesystems (ex.: ZFS); dd é o plano B.
    fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null ||
      dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    # Sem isto a swap some no próximo reboot.
    grep -qE '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
    info "swap ativa: $(awk '/SwapTotal/ {print int($2/1024)"M"}' /proc/meminfo)"
  fi
elif [[ $ram_mb -lt 2000 && $swap_mb -lt 256 ]]; then
  aviso "RAM de ${ram_mb}M sem swap e SWAP=0 — o npm ci pode ser morto por falta de memória"
fi

# ------------------------------------------------------- pacotes de sistema --
info "instalando dependências de sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# python3/make/g++ são para o node-gyp: better-sqlite3 é nativo e pode precisar
# compilar quando não houver binário pronto para o Node/arquitetura da VPS.
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git openssl python3 make g++ >/dev/null

# ------------------------------------------------------------------- node ----
node_major_atual() {
  command -v node >/dev/null || return 1
  node -p 'process.versions.node.split(".")[0]'
}
atual="$(node_major_atual || echo 0)"
if [[ $atual -ge $NODE_MAJOR ]]; then
  info "Node $(node -v) já atende (>= $NODE_MAJOR)"
else
  info "instalando Node $NODE_MAJOR via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if command -v pm2 >/dev/null; then
  info "PM2 já instalado ($(pm2 -v))"
else
  info "instalando PM2"
  npm install -g pm2 >/dev/null
fi

# ------------------------------------------------------------------ código ---
if [[ -d $APP_DIR/.git ]]; then
  info "atualizando repositório em $APP_DIR ($REPO_REF)"
  # Antes do fetch: o git recusa operar em repositório de outro dono.
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  como_app git -C "$APP_DIR" fetch --prune --tags origin
  como_app git -C "$APP_DIR" checkout --force "$REPO_REF"
  # Só quando REPO_REF é branch; para tag, o checkout acima já basta.
  if como_app git -C "$APP_DIR" rev-parse --verify --quiet "origin/$REPO_REF" >/dev/null; then
    como_app git -C "$APP_DIR" reset --hard "origin/$REPO_REF"
  fi
elif [[ -e $APP_DIR ]]; then
  erro "$APP_DIR existe mas não é um clone git — remova ou use outro APP_DIR"
else
  info "clonando $REPO_URL em $APP_DIR"
  mkdir -p "$APP_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DIR"
  como_app git clone --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
fi

# --------------------------------------------------------------------- env ---
ENV_FILE="$APP_DIR/.env"
if [[ -f $ENV_FILE ]]; then
  info ".env já existe — preservado"
else
  info "criando .env a partir de .env.example"
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  # O placeholder do .env.example não passa na validação de força do env.ts.
  segredo="$(openssl rand -hex 32)"
  sed -i "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$segredo|" "$ENV_FILE"
  aviso "WEBHOOK_SECRET gerado — configure o mesmo valor no provedor do webhook:"
  printf '   %s\n' "$segredo"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Um `.env` preservado de antes da introdução do HOST não tem a linha, e o
# default do env.ts é 0.0.0.0 — numa VPS com IP público isso põe o webhook, o
# GET /events e a string do QR em GET /whatsapp/status na internet, em HTTP
# puro. Não editamos o arquivo do operador; avisamos.
HOST_ENV="$(grep -E '^HOST=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
case "${HOST_ENV:-<ausente>}" in
  127.0.0.1 | localhost | ::1) ;;
  *)
    aviso "HOST=${HOST_ENV:-<ausente, default 0.0.0.0>} em $ENV_FILE — o serviço aceita conexões de fora."
    aviso "  Numa VPS com IP público use HOST=127.0.0.1 e ponha um proxy com TLS na frente:"
    aviso "  GET /whatsapp/status devolve a string do QR, e o WEBHOOK_SECRET viaja em claro."
    ;;
esac

# `data/` guarda credenciais da sessão do WhatsApp: só o dono enxerga.
como_app mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
chmod 700 "$APP_DIR/data"

# ------------------------------------------------------------------- build ---
info "instalando dependências do projeto (npm ci)"
(cd "$APP_DIR" && como_app npm ci --no-audit --no-fund >/dev/null)
info "compilando (npm run build)"
(cd "$APP_DIR" && como_app npm run build >/dev/null)

# --------------------------------------------------------------------- pm2 ---
ECOSYSTEM="$APP_DIR/ecosystem.config.cjs"
[[ -f $ECOSYSTEM ]] || erro "$ECOSYSTEM não encontrado — REPO_REF ($REPO_REF) é antigo demais?"

info "iniciando no PM2"
# startOrReload cobre primeiro boot e redeploy no mesmo comando, e relê o
# ecosystem — mudanças de configuração entram sem precisar de `pm2 delete`.
(cd "$APP_DIR" && como_app env NODE_ENV=production pm2 startOrReload "$ECOSYSTEM" --update-env)
como_app pm2 save >/dev/null

# ------------------------------------------------------------- logrotate -----
# O PM2 não rotaciona nada sozinho: com LOG_FORMAT=pretty e um monitor batendo
# em /health, logs/out.log cresce até encher o disco da droplet.
if [[ $LOGROTATE -eq 1 ]]; then
  if como_app pm2 describe pm2-logrotate >/dev/null 2>&1; then
    info "pm2-logrotate já instalado"
  else
    info "instalando pm2-logrotate"
    como_app pm2 install pm2-logrotate >/dev/null
  fi
  # `set` é idempotente e sobrescreve o valor anterior.
  como_app pm2 set pm2-logrotate:max_size 10M >/dev/null
  como_app pm2 set pm2-logrotate:retain 14 >/dev/null
  como_app pm2 set pm2-logrotate:compress true >/dev/null
  como_app pm2 set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null
  info "rotação: 10M por arquivo, 14 arquivos, comprimidos, giro diário"
fi

# Unit systemd que ressobe o daemon do PM2 (e os apps salvos) no boot da VPS.
info "habilitando PM2 no boot"
pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME"

PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
PORT="${PORT:-3000}"

# --------------------------------------------------------------------- ufw ---
# Opt-in: numa máquina remota, ativar firewall sem liberar SSH antes tranca o
# operador do lado de fora. A ordem aqui é deliberada — SSH primeiro, `enable`
# por último.
if [[ $UFW -eq 1 ]]; then
  info "configurando ufw"
  command -v ufw >/dev/null || apt-get install -y -qq ufw >/dev/null
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  # A porta do app não entra: quem fala com ela é o proxy, pelo loopback.
  ufw --force enable >/dev/null
  info "ufw ativo — liberados 22, 80 e 443; a porta $PORT fica só no loopback"
else
  aviso "firewall não configurado (UFW=0). Numa droplet nova o ufw vem inativo:"
  aviso "  verifique com 'ufw status' — sem ele, qualquer porta em escuta fica pública."
fi

# Reflete o que está no .env em vez de afirmar 127.0.0.1 sempre.
ESCUTA="${HOST_ENV:-0.0.0.0}"
cat <<EOF

Pronto. Serviço escutando em ${ESCUTA}:${PORT}

Próximos passos:
  1. Parear o WhatsApp:   sudo -u $APP_USER $APP_DIR/scripts/whatsapp-qr.sh
  2. Descobrir o JID:     curl -H "x-webhook-token: \$WEBHOOK_SECRET" \\
                            localhost:${PORT}/whatsapp/groups
  3. Preencher WHATSAPP_GROUP_JID em $ENV_FILE e recarregar:
       sudo -u $APP_USER pm2 reload $PM2_APP --update-env

Logs:   sudo -u $APP_USER pm2 logs $PM2_APP
Estado: curl localhost:${PORT}/health

TLS fica de fora: exponha o webhook por um proxy reverso com HTTPS apontando
para ${ESCUTA}:${PORT}. O WEBHOOK_SECRET viaja no header, e GET /whatsapp/status
devolve a string do QR — nada disso pode trafegar em HTTP puro na internet.
EOF
