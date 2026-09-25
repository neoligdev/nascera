#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════
# NASCERA — backup do estado + banco
#
# Sai do "RPO infinito": até aqui, um disco morto apagava os projetos, o
# saldo de todos os clientes e os segredos, sem nenhuma cópia. Este script
# junta as duas metades do estado — os arquivos JSON/segredos e o Postgres —
# num único tarball datado, com retenção.
#
#   ./scripts/backup.sh                    # backup local
#   NASCERA_BACKUP_DIR=/mnt/x ./backup.sh    # destino custom
#
# Para automatizar (cron diário às 3h):
#   0 3 * * * cd /caminho/1-sistema-nascera && ./scripts/backup.sh >> ~/.nascera-secrets/backup.log 2>&1
#
# ATENÇÃO: o backup CONTÉM SEGREDOS (.chave-cofre, .credenciais.json,
# .jwt-secret, senha do banco no dump). Guarde o destino com o mesmo cuidado
# que a máquina de produção — de preferência cifrado e offsite (S3/B2 com
# server-side encryption, ou `gpg` antes de subir).
# ═══════════════════════════════════════════════════════════════════════
set -e

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
DESTINO="${NASCERA_BACKUP_DIR:-$HOME/.nascera-backups}"
RETENCAO_DIAS="${NASCERA_BACKUP_RETENCAO:-14}"
CARIMBO="$(date +%Y-%m-%d_%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DESTINO"
echo "[backup $CARIMBO] iniciando"

# ── 1. Estado em arquivo (o que NÃO está no banco ainda) ──
# Inclui os segredos DE PROPÓSITO: sem eles, restaurar não reabre as sessões
# nem decifra o cofre. É o que torna o backup uma recuperação de verdade.
ESTADO="$TMP/estado"
mkdir -p "$ESTADO"
for f in users.json projects.json billing.json trash.json domains.json \
         theme.json activity-log.json integrations.json usage-events.jsonl \
         nascera-config.json .credenciais.json .jwt-secret .chave-cofre .cofre.json \
         .nascera-install.json; do
  [ -f "$RAIZ/$f" ] && cp -p "$RAIZ/$f" "$ESTADO/" || true
done
# Projetos dos usuários (o conteúdo real que a IA gerou)
if [ -d "$HOME/Nascera AI Projects" ]; then
  echo "[backup] projetos do usuário…"
  tar czf "$TMP/projetos-usuario.tar.gz" -C "$HOME" "Nascera AI Projects" \
    --exclude='node_modules' --exclude='.git' 2>/dev/null || true
fi

# ── 2. Banco (se configurado) ──
# Lê a DATABASE_URL do .env sem imprimi-la. pg_dump com --clean para o
# restore ser idempotente.
if [ -f "$RAIZ/.env" ]; then
  # NASCERA_BACKUP_DATABASE_URL tem precedência: a role de aplicação (nascera_app)
  # é restrita de propósito e NÃO enxerga a tabela _migracoes, então pg_dump
  # com ela falha. O backup usa uma role com leitura do schema inteiro (o dono
  # do banco), separada da que o app usa em runtime.
  DBURL="$(grep -E '^NASCERA_BACKUP_DATABASE_URL=' "$RAIZ/.env" | head -1 | cut -d= -f2-)"
  [ -z "$DBURL" ] && DBURL="$(grep -E '^DATABASE_URL=' "$RAIZ/.env" | head -1 | cut -d= -f2-)"
  if [ -n "$DBURL" ]; then
    echo "[backup] pg_dump…"
    pg_dump "$DBURL" --clean --if-exists --no-owner --no-privileges \
      -f "$TMP/banco.sql" 2>/dev/null \
      && echo "[backup] banco: $(wc -l < "$TMP/banco.sql") linhas" \
      || echo "[backup] AVISO: pg_dump falhou (banco desligado?) — seguindo só com estado"
  fi
fi

# ── 3. Empacota tudo, cifrando se houver senha ──
ALVO="$DESTINO/nascera-backup-$CARIMBO.tar.gz"
tar czf "$ALVO" -C "$TMP" .
chmod 600 "$ALVO"

if [ -n "$NASCERA_BACKUP_GPG_RECIPIENT" ]; then
  gpg --yes --encrypt -r "$NASCERA_BACKUP_GPG_RECIPIENT" "$ALVO" && rm -f "$ALVO"
  ALVO="$ALVO.gpg"
  echo "[backup] cifrado com gpg"
fi

TAM="$(du -h "$ALVO" | cut -f1)"
echo "[backup] ✓ $ALVO ($TAM)"

# ── 4. Retenção ──
find "$DESTINO" -name 'nascera-backup-*.tar.gz*' -mtime +"$RETENCAO_DIAS" -delete 2>/dev/null || true
N="$(ls -1 "$DESTINO"/nascera-backup-* 2>/dev/null | wc -l | tr -d ' ')"
echo "[backup] $N backup(s) retido(s) (limpando > $RETENCAO_DIAS dias)"
