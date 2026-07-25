#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/strapi-cms-git/backend/nxt-sourcing"
ENV_FILE="${APP_DIR}/.env.local"
LOCK_FILE="/tmp/nxt-ebay-walmart-price-refresh.lock"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

REFRESH_URL="${PRICE_REFRESH_URL:-http://127.0.0.1:3005/api/refresh-prices}"
REQUEST_LIMIT="${EBAY_WALMART_PRICE_REFRESH_LIMIT:-${MERCHANT_PRICE_REFRESH_LIMIT:-100}}"

if [[ -z "${PRICE_REFRESH_SECRET:-}" ]]; then
  echo "PRICE_REFRESH_SECRET is not set in ${ENV_FILE}" >&2
  exit 1
fi

# Skip (not fail) if another run is already in progress, so overlapping
# scheduled/manual runs don't get reported as errors.
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "$(date -Is) another run holds the lock; skipping"
  exit 0
fi

curl --fail --show-error --silent \
  --request POST "${REFRESH_URL}" \
  --header "Authorization: Bearer ${PRICE_REFRESH_SECRET}" \
  --header "Content-Type: application/json" \
  --data "{\"merchants\":[\"ebay\",\"walmart\"],\"limit\":${REQUEST_LIMIT}}"

echo
