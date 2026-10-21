#!/usr/bin/env bash
# Backup diário do banco (pg_dump, formato custom) com retenção de N dias.
#
# Produção: roda pelo timer atendimento-backup.timer como o usuário postgres (autenticação
# local "peer": nenhuma senha em arquivo). Instalado em /usr/local/bin/atendimento-backup.sh.
#
# Variáveis (todas opcionais):
#   BANCO          banco a copiar                 (padrão: atendimento)
#   PASTA_BACKUP   pasta dos arquivos             (padrão: /var/backups/atendimento)
#   DIAS_RETENCAO  apaga backups mais antigos     (padrão: 14)
#   PG_DUMP / PG_RESTORE  caminho dos binários    (padrão: pg_dump / pg_restore no PATH)
# Conexão: a padrão do libpq (PGHOST, PGPORT, PGUSER... se definidos; senão socket local).
#
# O backup tem dados pessoais (clientes, conversas): pasta 700, arquivos 600, e a cópia para
# fora do servidor deve ser criptografada (ver deploy/README.md).
set -euo pipefail

BANCO="${BANCO:-atendimento}"
PASTA="${PASTA_BACKUP:-/var/backups/atendimento}"
DIAS="${DIAS_RETENCAO:-14}"
PG_DUMP="${PG_DUMP:-pg_dump}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"

if ! [[ "$DIAS" =~ ^[0-9]+$ ]] || [ "$DIAS" -lt 1 ]; then
  echo "[backup] DIAS_RETENCAO inválido" >&2
  exit 2
fi

umask 077
mkdir -p "$PASTA"
chmod 700 "$PASTA"

# Carimbo no horário de Belém, qualquer que seja o fuso do servidor.
carimbo="$(TZ=America/Belem date +%Y-%m-%d_%H%M%S)"
destino="$PASTA/${BANCO}_${carimbo}.dump"
parcial="$destino.parcial"

# Grava num arquivo .parcial e só renomeia se o dump terminou e é legível.
if ! "$PG_DUMP" --format=custom --compress=6 --dbname="$BANCO" --file="$parcial"; then
  rm -f "$parcial"
  echo "[backup] FALHA: pg_dump de $BANCO não terminou; nenhum backup novo." >&2
  exit 1
fi

if ! "$PG_RESTORE" --list "$parcial" > /dev/null; then
  rm -f "$parcial"
  echo "[backup] FALHA: arquivo gerado para $BANCO não é legível pelo pg_restore." >&2
  exit 1
fi

mv "$parcial" "$destino"
tamanho="$(du -h "$destino" | cut -f1)"

# Retenção: apaga os backups deste banco com mais de DIAS dias.
removidos="$(find "$PASTA" -maxdepth 1 -type f -name "${BANCO}_*.dump" -mmin +"$((DIAS * 24 * 60))" -print -delete | wc -l)"

echo "[backup] ok: $(basename "$destino") ($tamanho) | removidos por retenção (${DIAS} dias): ${removidos}"
