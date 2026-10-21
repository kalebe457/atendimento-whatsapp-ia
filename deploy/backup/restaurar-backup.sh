#!/usr/bin/env bash
# Restaura um backup (formato custom) POR CIMA de um banco existente.
#
# Uso:  restaurar-backup.sh <arquivo.dump> <banco_destino>              (só mostra o que faria)
#       restaurar-backup.sh <arquivo.dump> <banco_destino> --confirmar  (restaura)
#
# ANTES de restaurar o atendimento: pare o backend (sudo systemctl stop atendimento) e, se
# possível, faça um backup do estado atual. Tudo numa transação: se falhar, nada muda.
# Rodar como o dono do banco (produção: sudo -u postgres ...).
# Conexão: a padrão do libpq (PGHOST, PGPORT, PGUSER... se definidos; senão socket local).
set -euo pipefail

PG_RESTORE="${PG_RESTORE:-pg_restore}"
PSQL="${PSQL:-psql}"

arquivo="${1:-}"
banco="${2:-}"
confirmar="${3:-}"

if [ -z "$arquivo" ] || [ -z "$banco" ] || [ ! -f "$arquivo" ]; then
  echo "Uso: restaurar-backup.sh <arquivo.dump> <banco_destino> [--confirmar]" >&2
  exit 2
fi

objetos="$("$PG_RESTORE" --list "$arquivo" | grep -vc '^;')"

# O backup traz as permissões do papel do backend (atendimento_app), mas papéis são do servidor,
# não do banco: num servidor novo ele precisa existir ANTES (sql/papeis/atendimento_app.sql), senão
# a restauração inteira é desfeita.
if "$PG_RESTORE" --schema-only --file=- "$arquivo" | grep -qw 'atendimento_app'; then
  existe="$("$PSQL" -X -A -t -d "$banco" -c "SELECT count(*) FROM pg_roles WHERE rolname = 'atendimento_app'")"
  if [ "$existe" != "1" ]; then
    echo "[restaurar] ABORTADO: o backup dá permissões ao papel atendimento_app, que não existe neste servidor. Crie o papel antes (sql/papeis/atendimento_app.sql) e rode de novo. Nada foi alterado." >&2
    exit 1
  fi
fi

if [ "$confirmar" != "--confirmar" ]; then
  echo "[restaurar] SIMULAÇÃO: $(basename "$arquivo") tem ${objetos} objeto(s); restauraria por cima de \"$banco\" (apaga e recria as tabelas). Nada foi alterado. Para executar, rode de novo com --confirmar."
  exit 0
fi

"$PG_RESTORE" --clean --if-exists --single-transaction --exit-on-error --dbname="$banco" "$arquivo"

echo "[restaurar] ok: $(basename "$arquivo") restaurado em \"$banco\" (${objetos} objeto(s))."
