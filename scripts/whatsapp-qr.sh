#!/usr/bin/env bash
#
# Mostra no terminal o QR pendente do WhatsApp e acompanha até a conexão abrir.
# Use quando a sessão cair e o número precisar ser pareado de novo.
#
#   ./scripts/whatsapp-qr.sh            # só exibe o QR que o serviço já emitiu
#   ./scripts/whatsapp-qr.sh --reset    # apaga a sessão e força um novo QR
#   ./scripts/whatsapp-qr.sh --reset -y # sem confirmação (uso em automação)
#
# O QR é lido de GET /whatsapp/status, não dos logs: o Baileys troca o código a
# cada ~20s e o endpoint sempre devolve o vigente. O script redesenha a cada
# troca — deixe rodando enquanto escaneia.
#
# --reset é para o caso em que o serviço fica preso sem emitir QR. Queda normal
# de sessão (`loggedOut`, 401) já é tratada sozinha em src/whatsapp/client.ts,
# que limpa o AUTH_DIR e reconecta; aí basta rodar sem flag.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$RAIZ/.env"
PM2_APP="${PM2_APP:-checkin-notifier}"

RESET=0
SIM=0
TIMEOUT="${TIMEOUT:-180}"
INTERVALO=2

uso() {
  cat <<'EOF'
Mostra o QR pendente do WhatsApp e acompanha até a conexão abrir.

  whatsapp-qr.sh              exibe o QR que o serviço já emitiu
  whatsapp-qr.sh --reset      apaga a sessão e força um novo QR
  whatsapp-qr.sh --reset -y   sem confirmação (automação)
  whatsapp-qr.sh -t 300       muda o tempo máximo de espera (padrão 180s)
EOF
}

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
aviso() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
erro() {
  printf '\033[1;31mxx\033[0m %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r | --reset) RESET=1 ;;
    -y | --yes) SIM=1 ;;
    -t | --timeout)
      TIMEOUT="${2:?--timeout exige um valor em segundos}"
      shift
      ;;
    -h | --help)
      uso
      exit 0
      ;;
    *) erro "opção desconhecida: $1" ;;
  esac
  shift
done

cd "$RAIZ"
[[ -f $ENV_FILE ]] || erro "$ENV_FILE não encontrado"
command -v node >/dev/null || erro "node não encontrado no PATH"

# Lê uma chave do .env sem dar `source` no arquivo (ele não é um script shell).
ler_env() {
  local valor
  valor="$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  valor="${valor%\"}"
  valor="${valor#\"}"
  printf '%s' "${valor:-${2:-}}"
}

PORT="$(ler_env PORT 3000)"
TOKEN="$(ler_env WEBHOOK_SECRET)"
AUTH_DIR="$(ler_env AUTH_DIR ./data/auth_info)"
BASE="http://127.0.0.1:$PORT"
[[ -n $TOKEN ]] || erro "WEBHOOK_SECRET vazio em $ENV_FILE"

# ------------------------------------------------------------------ reset ----
if [[ $RESET -eq 1 ]]; then
  pai="$(cd "$(dirname "$AUTH_DIR")" 2>/dev/null && pwd)" ||
    erro "diretório pai de AUTH_DIR ($AUTH_DIR) não existe"
  alvo="$pai/$(basename "$AUTH_DIR")"
  # Guarda contra um AUTH_DIR mal configurado transformar isto num `rm -rf` solto.
  # Dois níveis abaixo da raiz: recusa tanto caminhos de fora do projeto quanto
  # o próprio `data/`, que também guarda o banco.
  case "$alvo" in
    "$RAIZ"/*/*) ;;
    *) erro "recusando apagar $alvo — esperado algo como $RAIZ/data/auth_info" ;;
  esac

  if [[ $SIM -eq 0 ]]; then
    aviso "isto apaga $alvo e desconecta o número; será preciso escanear o QR de novo."
    read -rp "Confirma? [s/N] " resposta
    [[ ${resposta,,} == s ]] || erro "cancelado"
  fi

  if command -v pm2 >/dev/null && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    info "parando $PM2_APP"
    pm2 stop "$PM2_APP" >/dev/null
    rm -rf "$alvo"
    info "credenciais removidas; subindo de novo"
    pm2 start "$PM2_APP" >/dev/null
  else
    rm -rf "$alvo"
    aviso "PM2/$PM2_APP não encontrado — credenciais apagadas, reinicie o serviço à mão"
  fi
fi

# ------------------------------------------------------------------- poll ----
# Extrai um campo do JSON com o próprio node: sem dependência de jq na VPS.
campo() {
  node -e '
    let d = ""
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      try {
        const v = JSON.parse(d)[process.argv[1]]
        process.stdout.write(v == null ? "" : String(v))
      } catch {
        process.exit(1)
      }
    })
  ' "$1"
}

desenhar_qr() {
  # qrcode-terminal já é dependência do projeto (usada em client.ts); com o cwd
  # na raiz o require resolve sem instalar nada a mais.
  node -e 'require("qrcode-terminal").generate(process.argv[1], { small: true })' "$1" ||
    {
      aviso "não consegui renderizar o QR; string bruta abaixo (use: qrencode -t ANSIUTF8 <string>)"
      printf '%s\n' "$1"
    }
}

info "consultando $BASE/whatsapp/status (Ctrl-C para sair)"
qr_atual=""
fim=$((SECONDS + TIMEOUT))

while ((SECONDS < fim)); do
  corpo="$(curl -fsS --max-time 5 -H "x-webhook-token: $TOKEN" "$BASE/whatsapp/status" 2>/dev/null || true)"

  if [[ -z $corpo ]]; then
    # Esperado logo depois de um --reset, enquanto o processo volta.
    printf '\r\033[K... serviço não respondeu, tentando de novo'
    sleep "$INTERVALO"
    continue
  fi

  status="$(printf '%s' "$corpo" | campo status || echo '?')"
  qr="$(printf '%s' "$corpo" | campo qr || true)"

  case "$status" in
    open)
      printf '\r\033[K'
      info "conexão aberta — pareamento concluído"
      grupo="$(printf '%s' "$corpo" | campo groupJid || true)"
      [[ -n $grupo ]] ||
        aviso "WHATSAPP_GROUP_JID vazio: veja GET /whatsapp/groups e preencha o .env"
      exit 0
      ;;
    qr)
      if [[ $qr != "$qr_atual" ]]; then
        qr_atual="$qr"
        printf '\r\033[K'
        info "escaneie no celular do chip dedicado: WhatsApp → Dispositivos conectados"
        desenhar_qr "$qr"
      fi
      ;;
    *)
      printf '\r\033[K... status: %s' "$status"
      ;;
  esac

  sleep "$INTERVALO"
done

printf '\r\033[K'
erro "tempo esgotado (${TIMEOUT}s) sem conexão aberta — veja: pm2 logs $PM2_APP"
