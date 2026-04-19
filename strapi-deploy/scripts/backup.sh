#!/usr/bin/env bash
# Daily backup: PostgreSQL dump + uploads tarball.
# Schedule via crontab:  0 3 * * * /home/deploy/fxn-cms/scripts/backup.sh >> /var/log/fxn-backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAMP=$(date -u +%Y%m%d-%H%M%S)
mkdir -p backups

echo "[$STAMP] Dumping PostgreSQL..."
docker compose exec -T postgres pg_dump -U "$(grep ^DATABASE_USERNAME .env | cut -d= -f2)" "$(grep ^DATABASE_NAME .env | cut -d= -f2)" \
  | gzip > "backups/db-${STAMP}.sql.gz"

echo "[$STAMP] Archiving uploads..."
docker run --rm \
  -v fxnstudio-cms_strapi-uploads:/data:ro \
  -v "$ROOT/backups":/backup \
  alpine tar czf "/backup/uploads-${STAMP}.tar.gz" -C /data .

echo "[$STAMP] Pruning backups older than 14 days..."
find backups -type f \( -name 'db-*.sql.gz' -o -name 'uploads-*.tar.gz' \) -mtime +14 -delete

echo "[$STAMP] Backup complete: backups/db-${STAMP}.sql.gz, backups/uploads-${STAMP}.tar.gz"
