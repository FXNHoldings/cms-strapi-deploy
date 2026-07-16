#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/strapi-cms-git/backend/nxt-sourcing"
ENV_FILE="${APP_DIR}/.env.local"
LOCK_FILE="/tmp/nxt-rapidapi-merchant-price-refresh.lock"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

REFRESH_URL="${PRICE_REFRESH_URL:-http://127.0.0.1:3005/api/refresh-prices}"
REQUEST_LIMIT="${RAPIDAPI_MERCHANT_PRICE_REFRESH_LIMIT:-${MERCHANT_PRICE_REFRESH_LIMIT:-100}}"

if [[ -z "${PRICE_REFRESH_SECRET:-}" ]]; then
  echo "PRICE_REFRESH_SECRET is not set in ${ENV_FILE}" >&2
  exit 1
fi

if [[ -z "${RAPIDAPI_PRODUCT_SEARCH_KEY:-${RAPIDAPI_KEY:-}}" ]]; then
  echo "RAPIDAPI_PRODUCT_SEARCH_KEY or RAPIDAPI_KEY is not set in ${ENV_FILE}" >&2
  exit 1
fi

flock -n "${LOCK_FILE}" curl --fail --show-error --silent \
  --request POST "${REFRESH_URL}" \
  --header "Authorization: Bearer ${PRICE_REFRESH_SECRET}" \
  --header "Content-Type: application/json" \
  --data "{\"merchants\":[\"amazon\",\"newegg\",\"target\",\"best-buy\"],\"limit\":${REQUEST_LIMIT}}"

echo
