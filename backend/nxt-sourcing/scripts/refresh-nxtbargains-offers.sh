#!/usr/bin/env bash
# Refresh merchant offers and Amazon prices for nxt.bargains from DataForSEO.
#
# Two phases, both on the standard queue:
#   1. google/products -> google/sellers, via fetch-offers-sellers.mjs. Offers
#      are keyed on each product's Google product ID rather than matched by
#      title, so one variant's price cannot be attached to another.
#   2. amazon/asin, via refresh-amazon-prices-dataforseo.mjs, which reprices
#      Amazon offers from the ASIN in their /dp/ URL.
#
# Cost: about $0.51 a run for the 513 products carrying a googleProductId, plus
# a few cents for the Amazon repricing.
#
# Armed on the evidence of a dry run against this site: 810 offers before,
# 1017 after, 163 products improved, only 36 of 513 with no seller data. The
# equivalent job on nxtsmarthome.com.au does the reverse — it cut that site
# from 434 offers to 122 with zero improvements, because google/sellers returns
# nothing for 45% of its catalogue. Re-check the dry run before assuming this
# stays true; "products improved: 0" with offers falling is the signal to stop.
#
# STOPS AFTER END_DATE. Requested as a 7-day run, so it exits without spending
# anything from 2026-08-31. Remove the crontab line, or move this date, to
# continue.
set -euo pipefail

END_DATE="2026-08-30"
APP_DIR="/opt/strapi-cms-git/backend/nxt-sourcing"
ENV_FILE="${APP_DIR}/.env.local"
LOCK_FILE="/tmp/nxtbargains-offer-refresh.lock"
SITE="nxt.bargains"

if [[ "$(date -u +%F)" > "${END_DATE}" ]]; then
  echo "$(date -Is) past ${END_DATE}; the 7-day window is over, nothing to do"
  exit 0
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

if [[ -z "${DATAFORSEO_LOGIN:-}" || -z "${DATAFORSEO_PASSWORD:-}" ]]; then
  echo "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set in ${ENV_FILE}" >&2
  exit 1
fi

# Skip rather than fail if the previous run is still going, so an overlap is
# not paid for twice.
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "$(date -Is) another run holds the lock; skipping"
  exit 0
fi

cd "${APP_DIR}"
export NVM_DIR="${NVM_DIR:-/root/.nvm}"
# shellcheck source=/dev/null
[ -s "${NVM_DIR}/nvm.sh" ] && . "${NVM_DIR}/nvm.sh"
nvm use 22 >/dev/null

echo "$(date -Is) === refreshing merchant offers for ${SITE}"
node scripts/fetch-offers-sellers.mjs --site="${SITE}" --write

echo "$(date -Is) === repricing Amazon offers from ASIN"
# Non-fatal: this half is a top-up. A failure here should not make the run look
# like the offer refresh above also failed.
node scripts/refresh-amazon-prices-dataforseo.mjs --write || \
  echo "$(date -Is) amazon repricing failed; merchant offers were still refreshed"

# Free, and worth running after any bulk write: a refresh is exactly when an
# offer gets attached to the wrong product.
echo "$(date -Is) === auditing offer matches"
node scripts/audit-offer-matches.mjs --site="${SITE}" 2>/dev/null || \
  echo "$(date -Is) audit step failed; offers were still refreshed"

echo "$(date -Is) === done"
