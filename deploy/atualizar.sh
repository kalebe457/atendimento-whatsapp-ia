#!/usr/bin/env bash
# Atualiza o backend no servidor (README.md, passo 12):
#   git pull → npm ci → npm run build → npm run migrate → site → restart → /health
#
# Uso: sudo bash /opt/app/backend/deploy/atualizar.sh
#
# Para no primeiro erro (set -e): se o pull, o build ou a migration falharem, o backend que está
# rodando NÃO é reiniciado (continua a versão anterior). Não lê nem imprime o .env.
#
# Todo o corpo fica dentro de main(): o git pull pode trocar este arquivo enquanto ele roda, e o
# bash já leu a função inteira antes de executá-la.

set -euo pipefail

main() {
  local APP=/opt/app/backend
  local SITE=/var/www/atendimento
  local HEALTH=http://127.0.0.1:3000/health

  if [ "$(id -u)" -ne 0 ]; then
    echo "[atualizar] rode com sudo." >&2
    exit 1
  fi

  echo "[atualizar] git pull"
  sudo -u atendimento git -C "$APP" pull --ff-only

  echo "[atualizar] npm ci"
  sudo -u atendimento npm --prefix "$APP" ci

  echo "[atualizar] npm run build"
  sudo -u atendimento npm --prefix "$APP" run build

  echo "[atualizar] npm run migrate (como postgres, dono do banco)"
  sudo -u postgres bash -c "cd '$APP' && PGHOST=/var/run/postgresql PGDATABASE=atendimento npm run migrate"

  # Site da loja (página inicial e política): o Caddy não lê /opt/app (750).
  echo "[atualizar] site → $SITE"
  install -d -m 755 "$SITE"
  install -m 644 "$APP"/deploy/site/*.html "$SITE"/

  echo "[atualizar] systemctl restart atendimento"
  systemctl restart atendimento

  # A partida recupera do banco antes de ouvir (até ~30 s).
  local codigo=000
  local tentativa
  for tentativa in $(seq 1 45); do
    codigo="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH" || true)"
    if [ "$codigo" = "200" ]; then
      break
    fi
    sleep 1
  done

  echo "[atualizar] /health: $codigo"
  journalctl -u atendimento -n 20 --no-pager

  if [ "$codigo" != "200" ]; then
    echo "[atualizar] FALHA: /health não respondeu 200. Veja: sudo journalctl -u atendimento -n 100" >&2
    exit 1
  fi

  echo "[atualizar] concluído."
}

main "$@"
exit
