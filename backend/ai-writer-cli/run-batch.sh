#!/usr/bin/env bash
# Batch: 3 articles for each category except "flights", saved as DRAFTS on flightfares.one.
# Destinations articles use country names as keywords.
set -u
cd /opt/fxn-cms-git/backend/ai-writer-cli

# All categories except flights / uncategorized. Destinations is handled separately below.
CATS=(
  accommodation activities food-drink planning
  travel-tips budget-tips itineraries language travel-safety
  travel-types adventure backpacking budget-travel eco-tourism family
)

# Country keywords for the Destinations category (one article each).
COUNTRIES=("Japan" "Italy" "Thailand")

echo "=== batch start: $(date -u +%FT%TZ) ==="

# Destinations — country-keyworded, 1 article per country
for country in "${COUNTRIES[@]}"; do
  echo ">>> destinations / keyword=$country"
  node flightfares-publish.mjs --count 1 --category destinations --keywords "$country" 2>&1
done

# Every other category — 3 brainstormed articles each
for c in "${CATS[@]}"; do
  echo ">>> $c (x3)"
  node flightfares-publish.mjs --count 3 --category "$c" 2>&1
done

echo "=== batch done: $(date -u +%FT%TZ) ==="
