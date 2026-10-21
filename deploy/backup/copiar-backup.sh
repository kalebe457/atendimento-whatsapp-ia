#!/usr/bin/env bash
# Cópia CRIPTOGRAFADA dos backups locais para o Google Drive da loja (rclone + crypt) e limpeza do Drive.
#
# Produção: roda pelo timer atendimento-backup-copia.timer como o usuário postgres.
# Instalado em /usr/local/bin/atendimento-backup-copia.sh.
#
# Ordem (cada passo só roda se o anterior deu certo; qualquer falha sai com 1 e o OnFailure= avisa):
#   1. exige um backup local com menos de HORAS_BACKUP_RECENTE horas (sem ele: não envia e NÃO apaga);
#   2. envia o que falta (incremental; nunca arquivos .parcial);
#   3. confere que o backup mais recente está no Drive;
#   4. só então apaga do Drive os backups com mais de DIAS_DRIVE dias.
#
# Variáveis (todas opcionais):
#   PASTA_BACKUP          (padrão: /var/backups/atendimento)
#   REMOTO                remoto crypt do rclone (padrão: atendimento-cripto:)
#   BANCO                 prefixo dos arquivos (padrão: atendimento)
#   DIAS_DRIVE            retenção no Drive (padrão: 30)
#   HORAS_BACKUP_RECENTE  idade máxima do backup local mais novo (padrão: 26)
#   RCLONE                caminho do rclone (padrão: rclone no PATH)
set -euo pipefail

PASTA="${PASTA_BACKUP:-/var/backups/atendimento}"
REMOTO="${REMOTO:-atendimento-cripto:}"
BANCO="${BANCO:-atendimento}"
DIAS_DRIVE="${DIAS_DRIVE:-30}"
HORAS="${HORAS_BACKUP_RECENTE:-26}"
RCLONE="${RCLONE:-rclone}"
PADRAO="${BANCO}_*.dump"

if ! [[ "$DIAS_DRIVE" =~ ^[0-9]+$ && "$HORAS" =~ ^[0-9]+$ ]] || [ "$DIAS_DRIVE" -lt 1 ] || [ "$HORAS" -lt 1 ]; then
  echo "[backup-copia] DIAS_DRIVE ou HORAS_BACKUP_RECENTE inválido" >&2
  exit 2
fi

# 1. Backup local recente.
recente="$(find "$PASTA" -maxdepth 1 -type f -name "$PADRAO" -mmin -"$((HORAS * 60))" -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2)"
if [ -z "$recente" ]; then
  echo "[backup-copia] FALHA: nenhum backup local com menos de ${HORAS} h em ${PASTA}; nada enviado e nada apagado do Drive." >&2
  exit 1
fi

# 2. Envia o que falta (só arquivos completos: *.dump; *.dump.parcial não casa com o filtro).
"$RCLONE" copy "$PASTA" "$REMOTO" --include "$PADRAO" --log-level NOTICE

# 3. Confere que o mais recente chegou.
if ! "$RCLONE" lsf "$REMOTO" --include "$PADRAO" | grep -qxF "$recente"; then
  echo "[backup-copia] FALHA: ${recente} não aparece no Drive depois do envio; nada apagado do Drive." >&2
  exit 1
fi

# 4. Só agora, a retenção do Drive.
"$RCLONE" delete "$REMOTO" --include "$PADRAO" --min-age "${DIAS_DRIVE}d" --log-level NOTICE

echo "[backup-copia] ok: ${recente} está no Drive | removidos do Drive os backups com mais de ${DIAS_DRIVE} dias"
