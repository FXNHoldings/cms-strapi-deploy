#!/usr/bin/env bash
# Refresh merchant offers for nxtsmarthome.com.au from DataForSEO.
#
# Runs fetch-offers-sellers.mjs scoped to this site. That script keys on each
# product's Google product ID rather than matching titles, so it cannot attach
# one variant's price to another — the failure mode that makes a price table
# quietly wrong. New merchants found for a product get an offer created;
# superseded ones are retired.
#
# Cost: DataForSEO bills roughly $0.001 per product, so about $0.17 for the
# ~168 published products here. The lock below means a long run that overlaps
# the next schedule is skipped rather than paying twice.
#
# audit-offers and check-offers are free and worth running after any bulk
# refresh — the first catches offers attached to the wrong product, the second
# retires dead links.
set -euo pipefail

APP_DIR="/opt/strapi-cms-git/backend/nxt-sourcing"
ENV_FILE="${APP_DIR}/.env.local"
LOCK_FILE="/tmp/nxtsmarthome-offer-refresh.lock"
SITE="nxtsmarthome.com.au"

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

# Skip (not fail) if a previous run is still going, so an overlap is not
# reported as an error — and, more to the point, is not paid for twice.
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

echo "$(date -Is) refreshing offers for ${SITE}"
node scripts/fetch-offers-sellers.mjs --site="${SITE}" --write

# Free, and the point of running it here: a bulk refresh is exactly when an
# offer gets attached to the wrong product, and this is what catches it.
echo "$(date -Is) auditing offers"
node scripts/audit-offer-matches.mjs --site="${SITE}" 2>/dev/null || \
  echo "$(date -Is) audit step failed; offers were still refreshed"

echo "$(date -Is) done"
