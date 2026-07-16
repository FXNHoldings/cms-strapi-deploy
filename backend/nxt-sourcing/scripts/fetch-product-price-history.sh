#!/usr/bin/env bash
set -euo pipefail

echo "fetch-product-price-history.sh is disabled because the provider history data was unreliable. No changes were made." >&2
echo "Re-enable only after choosing a verified price-history provider." >&2
exit 1

APP_DIR="/opt/strapi-cms-git/backend/nxt-sourcing"
ENV_FILE="${APP_DIR}/.env.local"
LOCK_FILE="/tmp/nxt-product-price-history-refresh.lock"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

if [[ -z "${STRAPI_API_TOKEN:-}" ]]; then
  echo "STRAPI_API_TOKEN is not set in ${ENV_FILE}" >&2
  exit 1
fi

if [[ -z "${RAPIDAPI_PRODUCT_SEARCH_KEY:-${RAPIDAPI_KEY:-}}" ]]; then
  echo "RAPIDAPI_PRODUCT_SEARCH_KEY or RAPIDAPI_KEY is not set in ${ENV_FILE}" >&2
  exit 1
fi

cd "${APP_DIR}"
flock -n "${LOCK_FILE}" /usr/bin/node scripts/fetch-product-price-history.mjs --write
