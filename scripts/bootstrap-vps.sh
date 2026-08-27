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
set -euo pipefail

APP_USER="${APP_USER:-checkin}"
APP_DIR="${APP_DIR:-/opt/checkin-notifier}"
REPO_URL="${REPO_URL:-https://github.com/luizmuniztravus/airbnb.git}"
REPO_REF="${REPO_REF:-main}"
NODE_MAJOR="${NODE_MAJOR:-24}"
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

# Unit systemd que ressobe o daemon do PM2 (e os apps salvos) no boot da VPS.
info "habilitando PM2 no boot"
pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME"

PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
cat <<EOF

Pronto. Serviço em http://127.0.0.1:${PORT:-3000}

Próximos passos:
  1. Parear o WhatsApp:   sudo -u $APP_USER $APP_DIR/scripts/whatsapp-qr.sh
  2. Descobrir o JID:     curl -H "x-webhook-token: \$WEBHOOK_SECRET" \\
                            localhost:${PORT:-3000}/whatsapp/groups
  3. Preencher WHATSAPP_GROUP_JID em $ENV_FILE e recarregar:
       sudo -u $APP_USER pm2 reload $PM2_APP --update-env

Logs:   sudo -u $APP_USER pm2 logs $PM2_APP
Estado: curl localhost:${PORT:-3000}/health

Este script não abre porta no firewall nem configura TLS. Exponha o webhook
por um proxy reverso com HTTPS — o WEBHOOK_SECRET viaja no header.
EOF
