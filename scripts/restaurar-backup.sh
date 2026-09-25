#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════
# NASCERA — restaura um backup gerado por backup.sh
#
#   ./scripts/restaurar-backup.sh <arquivo.tar.gz> [--banco DATABASE_URL]
#
# Extrai para uma pasta de INSPEÇÃO (não sobrescreve nada automaticamente):
# recuperação de desastre é operação consciente, não um clique. Mostra o que
# há dentro e, com --banco, restaura o Postgres no destino indicado.
# ═══════════════════════════════════════════════════════════════════════
set -e

ARQ="$1"
[ -f "$ARQ" ] || { echo "uso: restaurar-backup.sh <arquivo.tar.gz> [--banco DATABASE_URL]"; exit 1; }

DEST="$(mktemp -d)/restore"
mkdir -p "$DEST"
echo "[restore] extraindo $ARQ"
tar xzf "$ARQ" -C "$DEST"

echo "[restore] conteúdo:"
[ -d "$DEST/estado" ] && ls -la "$DEST/estado" | sed 's/^/    /'
[ -f "$DEST/banco.sql" ] && echo "    banco.sql ($(wc -l < "$DEST/banco.sql") linhas)"
[ -f "$DEST/projetos-usuario.tar.gz" ] && echo "    projetos-usuario.tar.gz"

echo "[restore] estado extraído em: $DEST"
echo "[restore] revise e copie manualmente o que precisar de volta."

# Banco: só com --banco explícito e destino informado.
if [ "$2" = "--banco" ] && [ -n "$3" ] && [ -f "$DEST/banco.sql" ]; then
  echo "[restore] restaurando banco em $3 …"
  psql "$3" -f "$DEST/banco.sql" >/dev/null
  echo "[restore] ✓ banco restaurado"
fi
