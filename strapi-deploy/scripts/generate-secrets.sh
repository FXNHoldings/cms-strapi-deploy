#!/usr/bin/env bash
# Generate Strapi secrets and append to .env
# Usage: ./scripts/generate-secrets.sh > secrets.env
set -euo pipefail

gen() { openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_'; }

cat <<EOF
# --- Generated secrets ($(date -u +%FT%TZ)) ---
APP_KEYS=$(gen),$(gen),$(gen),$(gen)
API_TOKEN_SALT=$(gen)
ADMIN_JWT_SECRET=$(gen)
TRANSFER_TOKEN_SALT=$(gen)
JWT_SECRET=$(gen)
ENCRYPTION_KEY=$(gen)
DATABASE_PASSWORD=$(gen)
EOF
