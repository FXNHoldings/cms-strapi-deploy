#!/usr/bin/env bash
# Restore from a backup pair. Usage:
#   ./scripts/restore.sh backups/db-YYYYMMDD-HHMMSS.sql.gz backups/uploads-YYYYMMDD-HHMMSS.tar.gz
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <db.sql.gz> <uploads.tar.gz>" >&2
  exit 1
fi

DB="$1"; UP="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

read -rp "This will WIPE current DB and uploads. Continue? (yes/no) " ok
[[ "$ok" == "yes" ]] || exit 1

echo ">>> Stopping strapi..."
docker compose stop strapi

echo ">>> Restoring DB from $DB"
gunzip -c "$DB" | docker compose exec -T postgres psql -U "$(grep ^DATABASE_USERNAME .env | cut -d= -f2)" -d "$(grep ^DATABASE_NAME .env | cut -d= -f2)"

echo ">>> Restoring uploads from $UP"
docker run --rm \
  -v fxnstudio-cms_strapi-uploads:/data \
  -v "$ROOT/$(dirname "$UP")":/backup \
  alpine sh -c "cd /data && rm -rf * && tar xzf /backup/$(basename "$UP")"

echo ">>> Restarting strapi..."
docker compose start strapi
echo ">>> Done."
