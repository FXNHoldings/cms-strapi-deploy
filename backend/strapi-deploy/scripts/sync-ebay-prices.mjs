#!/usr/bin/env node
/**
 * Sync eBay prices for products in Strapi (`bls-product`).
 *
 * For each product (or a single product when SLUG is set):
 *   1. Build search query from `<brand> <name>` (lightly cleaned).
 *   2. Call eBay Browse API /buy/browse/v1/item_summary/search.
 *   3. Pick best match — NEW condition + brand must appear in title.
 *   4. PUT ebayPrice / ebayUrl / ebayLastSyncAt back to Strapi.
 *
 * eBay Browse API free tier: 5,000 calls/day. App token caches in-process.
 *
 * Required env:
 *   STRAPI_URL              default: http://127.0.0.1:8888
 *   STRAPI_TOKEN            REQUIRED — Strapi → Settings → API Tokens
 *   EBAY_CLIENT_ID          REQUIRED — developer.ebay.com app keys
 *   EBAY_CLIENT_SECRET      REQUIRED
 *
 * Optional env:
 *   EBAY_MARKETPLACE              default: EBAY_US
 *   EBAY_AFFILIATE_CAMPAIGN_ID    if set, eBay item URL gets the EPN affiliate
 *                                 wrapper (https://www.ebay.com/itm/...?campid=...)
 *   LIMIT                         cap product count (default: all)
 *   DRY_RUN=1                     skip Strapi writes
 *   ONLY_MISSING=1                skip products with ebayLastSyncAt < 24h
 *   SLUG=<slug>                   process only one product (by slug)
 *   VERBOSE=1                     print full request/response for debugging
 *
 * Usage:
 *   STRAPI_TOKEN=... EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... \
 *     node scripts/sync-ebay-prices.mjs
 *
 *   # one product
 *   SLUG=cerave-foaming-cleanser node scripts/sync-ebay-prices.mjs
 *
 *   # daily refresh (skip recently-synced)
 *   ONLY_MISSING=1 node scripts/sync-ebay-prices.mjs
 */

import { Buffer } from 'node:buffer';

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const EBAY_MARKETPLACE = process.env.EBAY_MARKETPLACE || 'EBAY_US';
const EBAY_CAMPAIGN_ID = process.env.EBAY_AFFILIATE_CAMPAIGN_ID || '';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
const DRY_RUN = process.env.DRY_RUN === '1';
const ONLY_MISSING = process.env.ONLY_MISSING === '1';
const SLUG = process.env.SLUG || '';
const VERBOSE = process.env.VERBOSE === '1';

if (!STRAPI_TOKEN) abort('STRAPI_TOKEN env var is required');
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) abort('EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required');

function abort(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// eBay OAuth (Client Credentials) — token cached in-process for ~2h
// --------------------------------------------------------------------------
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 60_000) return cachedToken;
  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`eBay token failed: ${r.status} ${txt}`);
  }
  const j = await r.json();
  cachedToken = j.access_token;
  cachedTokenExpiry = Date.now() + (j.expires_in ?? 7200) * 1000;
  return cachedToken;
}

// --------------------------------------------------------------------------
// eBay Browse API — search by keywords, NEW only
// --------------------------------------------------------------------------
async function searchEbay(query) {
  const token = await getEbayToken();
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '10');
  url.searchParams.set('filter', 'conditionIds:{1000}'); // 1000 = NEW
  const headers = {
    'Authorization': `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE,
    'Accept': 'application/json',
  };
  if (EBAY_CAMPAIGN_ID) {
    headers['X-EBAY-C-ENDUSERCTX'] = `affiliateCampaignId=${EBAY_CAMPAIGN_ID}`;
  }
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`eBay search failed: ${r.status} ${txt.slice(0, 300)}`);
  }
  const j = await r.json();
  return j.itemSummaries || [];
}

// Pick best match: brand must appear in title (case-insensitive), then
// pick the lowest-priced item. Skips obvious sample/travel/sample-size results
// when the original product isn't a sample.
function pickBestMatch(items, { brand, name }) {
  const brandLc = (brand || '').toLowerCase().trim();
  const nameLc = (name || '').toLowerCase();
  const isSample = /sample|travel size|deluxe sample/i.test(name);

  const candidates = items.filter((it) => {
    const title = (it.title || '').toLowerCase();
    if (brandLc && !title.includes(brandLc)) return false;
    if (!isSample && /sample|travel size|deluxe sample/.test(title)) return false;
    if (!it.price?.value) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Prefer items with a non-trivial title-overlap with the product name —
  // require at least 2 word matches beyond the brand. Falls back to lowest
  // price if no strong matches.
  const nameWords = nameLc.split(/\W+/).filter((w) => w.length > 3 && w !== brandLc);
  candidates.forEach((it) => {
    const title = (it.title || '').toLowerCase();
    it._wordHits = nameWords.filter((w) => title.includes(w)).length;
    it._priceNum = parseFloat(it.price.value);
  });
  candidates.sort((a, b) => {
    if (b._wordHits !== a._wordHits) return b._wordHits - a._wordHits;
    return a._priceNum - b._priceNum;
  });
  // Require at least 2 word hits OR the brand alone if the product has a
  // very short name.
  const top = candidates[0];
  if (top._wordHits < 2 && nameWords.length >= 3) return null;
  return top;
}

// Keep only EPN affiliate params from an eBay item URL; strip search-context
// params that bloat the URL without adding tracking value.
const EBAY_AFFILIATE_PARAMS = new Set([
  'mkevt', 'mkcid', 'mkrid', 'campid', 'toolid', 'customid',
]);
function cleanEbayUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const kept = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (EBAY_AFFILIATE_PARAMS.has(k)) kept.append(k, v);
    }
    u.search = kept.toString();
    return u.toString();
  } catch {
    return url.split('?')[0];
  }
}

// --------------------------------------------------------------------------
// Strapi — list products + update by documentId
// --------------------------------------------------------------------------
async function strapi(path, init = {}) {
  const r = await fetch(`${STRAPI_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${STRAPI_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Strapi ${init.method || 'GET'} ${path} → ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

async function* iterateProducts() {
  if (SLUG) {
    const r = await strapi(
      `/api/bls-products?filters[slug][$eq]=${encodeURIComponent(SLUG)}&pagination[pageSize]=1`,
    );
    yield* r.data || [];
    return;
  }
  let page = 1;
  for (;;) {
    const r = await strapi(`/api/bls-products?pagination[page]=${page}&pagination[pageSize]=100`);
    const items = r.data || [];
    if (items.length === 0) break;
    yield* items;
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page += 1;
  }
}

async function updateProduct(documentId, patch) {
  if (DRY_RUN) return;
  await strapi(`/api/bls-products/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: patch }),
  });
}

// Append a time-series snapshot row to bls-price-snapshot. Best-effort —
// failures are warned but don't abort the sync, since the live `ebayPrice`
// field is the primary store and the snapshot table is just history.
async function recordPriceSnapshot({ productDocumentId, merchant, price, currency, available }) {
  if (DRY_RUN) return;
  try {
    await strapi('/api/bls-price-snapshots', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          product: productDocumentId,
          merchant,
          price,
          currency: currency || 'USD',
          available: available !== false,
          recordedAt: new Date().toISOString(),
          source: 'sync-script',
        },
      }),
    });
  } catch (err) {
    console.warn(`    [warn] snapshot write failed: ${err.message.slice(0, 120)}`);
  }
}

// --------------------------------------------------------------------------
// Query builder — strip noisy marketing words to give eBay a clean query
// --------------------------------------------------------------------------
function buildQuery({ brand, name }) {
  // If the product name already starts with the brand, don't double it.
  const nameStr = (name || '').trim();
  const brandStr = (brand || '').trim();
  const startsWithBrand = brandStr && nameStr.toLowerCase().startsWith(brandStr.toLowerCase());
  let q = (startsWithBrand ? nameStr : `${brandStr} ${nameStr}`).trim();
  q = q.replace(/\([^)]*\)/g, ' ');           // drop parenthetical noise
  q = q.replace(/\b(pack of \d+|\d+\s*(pack|count|ct|fl\.?\s*oz|oz|ml|g))\b/gi, ' ');
  q = q.replace(/\b(new|sealed|authentic|original|brand new|free shipping)\b/gi, ' ');
  q = q.replace(/[^\w\s.\-+&']/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  // eBay caps q at ~100 chars; keep first 8 meaningful words.
  return q.split(' ').slice(0, 10).join(' ');
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
async function main() {
  console.log(`▶ syncing eBay prices via ${STRAPI_URL}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  let processed = 0;
  let matched = 0;
  let skipped = 0;
  let unmatched = 0;
  let errored = 0;

  for await (const p of iterateProducts()) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    processed += 1;

    const { documentId, name, brand, slug, ebayLastSyncAt } = p;
    if (ONLY_MISSING && ebayLastSyncAt) {
      const ageMs = Date.now() - new Date(ebayLastSyncAt).getTime();
      if (ageMs < 24 * 3600 * 1000) {
        skipped += 1;
        continue;
      }
    }

    const query = buildQuery({ brand, name });
    if (!query) {
      console.log(`  ${slug}: empty query, skip`);
      unmatched += 1;
      continue;
    }

    try {
      const items = await searchEbay(query);
      if (VERBOSE) console.log(`    [${slug}] q="${query}" → ${items.length} results`);
      const best = pickBestMatch(items, { brand, name });
      if (!best) {
        console.log(`  ✗ ${slug}: no match for "${query}"`);
        unmatched += 1;
        continue;
      }
      const price = parseFloat(best.price.value);
      // eBay URLs come back with two kinds of query params: search-context
      // (_skw, hash) which are noise, and EPN affiliate tracking
      // (mkevt, mkcid, mkrid, campid, toolid, customid) which we must keep
      // when EBAY_AFFILIATE_CAMPAIGN_ID is set. Strip the noise but preserve
      // the tracking — keeps URLs short (under 500 chars) and properly tagged.
      const url = cleanEbayUrl(best.itemAffiliateWebUrl || best.itemWebUrl);
      console.log(`  ✓ ${slug}: $${price} ← "${best.title.slice(0, 60)}…"`);
      await updateProduct(documentId, {
        ebayPrice: price,
        ebayUrl: url,
        ebayLastSyncAt: new Date().toISOString(),
      });
      await recordPriceSnapshot({
        productDocumentId: documentId,
        merchant: 'ebay',
        price,
        currency: 'USD',
      });
      matched += 1;
    } catch (err) {
      console.error(`  ! ${slug}: ${err.message}`);
      errored += 1;
    }

    // Polite throttle — eBay free tier is 5K/day, but back off to be safe.
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(
    `\nDone. processed=${processed} matched=${matched} unmatched=${unmatched} skipped=${skipped} errored=${errored}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
