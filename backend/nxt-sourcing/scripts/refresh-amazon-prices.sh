#!/usr/bin/env bash
# Refresh Amazon product prices via the Amazon Product Info2 RapidAPI
# (https://rapidapi.com/mahmudulhasandev/api/amazon-product-info2), the only
# active RapidAPI subscription. POSTs the sourcing app's /api/refresh-prices
# endpoint with merchants=["amazon"], which re-prices each product's Amazon
# offer through providers.ts (RAPIDAPI_AMAZON_PROVIDER=amazon-product-info2).
#
# Amazon-only by design: Amazon Product Info2 cannot see other retailers.
# eBay/Walmart have their own direct-API refresh (refresh-ebay-walmart-prices.sh).
set -euo pipefail

APP_DIR="/opt/strapi-cms-git/backend/nxt-sourcing"
ENV_FILE="${APP_DIR}/.env.local"
LOCK_FILE="/tmp/nxt-amazon-price-refresh.lock"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

REFRESH_URL="${PRICE_REFRESH_URL:-http://127.0.0.1:3005/api/refresh-prices}"
REQUEST_LIMIT="${AMAZON_PRICE_REFRESH_LIMIT:-100}"

if [[ -z "${PRICE_REFRESH_SECRET:-}" ]]; then
  echo "PRICE_REFRESH_SECRET is not set in ${ENV_FILE}" >&2
  exit 1
fi

if [[ -z "${RAPIDAPI_AMAZON_KEY:-${RAPIDAPI_KEY:-}}" ]]; then
  echo "RAPIDAPI_AMAZON_KEY (or RAPIDAPI_KEY) is not set in ${ENV_FILE}" >&2
  exit 1
fi

flock -n "${LOCK_FILE}" curl --fail --show-error --silent \
  --request POST "${REFRESH_URL}" \
  --header "Authorization: Bearer ${PRICE_REFRESH_SECRET}" \
  --header "Content-Type: application/json" \
  --data "{\"merchants\":[\"amazon\"],\"limit\":${REQUEST_LIMIT}}"

echo
