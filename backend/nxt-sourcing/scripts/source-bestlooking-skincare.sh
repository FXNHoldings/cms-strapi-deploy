#!/usr/bin/env bash
#
# Source bestlooking.skin's six skincare categories end to end.
#
#   ./scripts/source-bestlooking-skincare.sh            # dry run, writes nothing
#   ./scripts/source-bestlooking-skincare.sh --write
#   ./scripts/source-bestlooking-skincare.sh --write --category=facial-serums
#
# Three passes per category, in this order and for these reasons:
#
#   1. source-category-pipeline   the curated name list -> products + offers.
#                                 Gated: a product needs a googleProductId, two
#                                 offers, and at least one Tier 1/2 retailer
#                                 among them (see --require-anchor).
#   2. enrich-products-product-info   description, specs, real images and the
#                                 REAL storefront URL. The search endpoint the
#                                 first pass uses returns url:null, so without
#                                 this an offer can only link to a retailer
#                                 search page -- not something to hang an
#                                 affiliate link on.
#   3. fetch-offers-sellers --thin-only   tops up anything still under two
#                                 offers, keyed on product id rather than title
#                                 so it needs no title matching.
#
# Every pass is re-runnable. DataForSEO task ids are cached in reports/, so a
# repeat run re-collects completed tasks for free instead of re-buying them.
set -uo pipefail
cd "$(dirname "$0")/.."

WRITE=""; ONLY=""
for a in "$@"; do
  case "$a" in
    --write) WRITE="--write" ;;
    --category=*) ONLY="${a#--category=}" ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

set -a; . ./.env.local; set +a
export STRAPI_API_TOKEN="${STRAPI_API_TOKEN_OVERRIDE:-$STRAPI_API_TOKEN}"

# Fail fast on the token rather than after paying for a category's tasks. Every
# API token 401'd on 11 Sep when the container's API_TOKEN_SALT drifted, and the
# first run of this wasted a full sweep discovering that at the write step.
# -g (globoff): curl otherwise reads the [ ] in the query string as a glob
# range, fails before sending, and reports an empty status -- which reads
# exactly like an auth failure and sent the first run chasing a valid token.
code=$(curl -s -g -o /dev/null -w '%{http_code}' -m 20 \
  -H "Authorization: Bearer ${STRAPI_API_TOKEN:-}" \
  "${STRAPI_INTERNAL_URL:-http://127.0.0.1:8888}/api/commerce-categories?pagination[pageSize]=1")
if [ "$code" != "200" ]; then
  echo "STRAPI_API_TOKEN is not valid (GET commerce-categories -> $code)." >&2
  echo "Mint a full-access token in the Strapi admin and set STRAPI_API_TOKEN in .env.local." >&2
  exit 1
fi
echo "strapi token OK"

CATEGORIES="facial-cleansers facial-serums moisturisers anti-aging toners-and-astringents exfoliators-and-scrubs hyaluronic-acid"
[ -n "$ONLY" ] && CATEGORIES="$ONLY"

mkdir -p reports/bestlooking
for c in $CATEGORIES; do
  echo; echo "======================================================== $c"
  node scripts/source-category-pipeline.mjs \
    --category="$c" \
    --products-file="data/skincare-products/$c.txt" \
    --tag=bestlooking-skin \
    --require-gid --min-offers=2 --require-anchor \
    --no-reviews $WRITE 2>&1 | tee "reports/bestlooking/$c-1-source.log" | tail -5

  if [ -n "$WRITE" ]; then
    # Both of these default their site filter to nxt-bargains and AND it with
    # --category, so without the tag they select nothing and report "products: 0"
    # -- a silent no-op that looks like a completed pass.
    node scripts/enrich-products-product-info.mjs --category="$c" --site-tag=bestlooking-skin --write \
      2>&1 | tee "reports/bestlooking/$c-2-enrich.log" | tail -4
    node scripts/fetch-offers-sellers.mjs --category="$c" --tag=bestlooking-skin --thin-only --write \
      2>&1 | tee "reports/bestlooking/$c-3-sellers.log" | tail -4
  fi
done

echo; echo "logs: reports/bestlooking/"
