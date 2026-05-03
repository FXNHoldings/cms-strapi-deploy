#!/usr/bin/env node
/**
 * Sync Walmart prices for products in Strapi (`bls-product`) via Impact API.
 *
 * Strategy — per-brand catalog query (no full-catalog dump needed):
 *   1. Group Strapi products by brand.
 *   2. For each brand, query Impact's Catalog Items endpoint with
 *      `Query=Manufacturer='<brand>'` across the 4 skincare-relevant catalogs:
 *         9671  02 PERSONAL CARE
 *         9763  46 BEAUTY
 *         10700 3P 02 PERSONAL CARE
 *         10745 3P 46 BEAUTY
 *      The query is case-sensitive and equality-only — we try a few common
 *      casings (as-is, Title Case, lowercase) before giving up.
 *   3. Fuzzy-score each candidate by token-overlap with the product name.
 *      Pick the top scorer above MIN_OVERLAP, prefer InStock, prefer lowest
 *      price among ties.
 *   4. PUT walmartPrice / walmartUrl / walmartLastSyncAt back to Strapi.
 *
 * Required env:
 *   STRAPI_URL              default: http://127.0.0.1:8888
 *   STRAPI_TOKEN            REQUIRED
 *   IMPACT_SID              REQUIRED — Impact Mediapartner Account SID
 *   IMPACT_TOKEN            REQUIRED — Impact API auth token
 *
 * Optional env:
 *   LIMIT                   cap product count
 *   DRY_RUN=1               skip Strapi writes
 *   ONLY_MISSING=1          skip products with walmartLastSyncAt < 24h
 *   SLUG=<slug>             one product only
 *   MIN_OVERLAP             min name-token hits for a match (default 2)
 *   VERBOSE=1               print full match scoring for debugging
 *
 * Usage:
 *   STRAPI_TOKEN=... IMPACT_SID=... IMPACT_TOKEN=... \
 *     node scripts/sync-walmart-prices.mjs
 */

import { Buffer } from 'node:buffer';

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const IMPACT_SID = process.env.IMPACT_SID;
const IMPACT_TOKEN = process.env.IMPACT_TOKEN;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
const DRY_RUN = process.env.DRY_RUN === '1';
const ONLY_MISSING = process.env.ONLY_MISSING === '1';
const SLUG = process.env.SLUG || '';
const MIN_OVERLAP = process.env.MIN_OVERLAP ? parseInt(process.env.MIN_OVERLAP, 10) : 2;
const VERBOSE = process.env.VERBOSE === '1';

const CATALOG_IDS = ['9671', '9763', '10700', '10745'];

if (!STRAPI_TOKEN) abort('STRAPI_TOKEN env var is required');
if (!IMPACT_SID || !IMPACT_TOKEN) abort('IMPACT_SID and IMPACT_TOKEN are required');

function abort(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Impact API — paginated catalog item search by Manufacturer
// --------------------------------------------------------------------------
const impactBasic = Buffer.from(`${IMPACT_SID}:${IMPACT_TOKEN}`).toString('base64');

async function impactGet(path) {
  const r = await fetch(`https://api.impact.com${path}`, {
    headers: { Authorization: `Basic ${impactBasic}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Impact ${path} → ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchByManufacturer(catalogId, manufacturer) {
  const items = [];
  let cursorPath = `/Mediapartners/${IMPACT_SID}/Catalogs/${catalogId}/Items`
    + `?PageSize=1000&Query=${encodeURIComponent(`Manufacturer='${manufacturer}'`)}`;
  for (;;) {
    const r = await impactGet(cursorPath);
    if (r.Status === 'ERROR') throw new Error(`Impact query: ${r.Message}`);
    items.push(...(r.Items || []));
    if (!r['@nextpageuri']) break;
    cursorPath = r['@nextpageuri'];
  }
  return items;
}

// Brand cache so the same brand doesn't get re-queried for every product.
const brandCache = new Map();
async function getCatalogItemsForBrand(brand) {
  const key = brand.toLowerCase();
  if (brandCache.has(key)) return brandCache.get(key);

  const variants = uniqueCasings(brand);
  let items = [];
  for (const variant of variants) {
    const perCatalog = await Promise.all(
      CATALOG_IDS.map((c) => fetchByManufacturer(c, variant).catch(() => [])),
    );
    items = perCatalog.flat();
    if (items.length > 0) {
      if (VERBOSE) console.log(`    [brand="${brand}"] matched as "${variant}" → ${items.length} items`);
      break;
    }
  }
  brandCache.set(key, items);
  return items;
}

// Generate likely casings for an unknown brand. Walmart's Manufacturer field
// is case-sensitive, so we try a few variants when the original fails.
function uniqueCasings(brand) {
  const out = new Set([brand]);
  out.add(brand.toLowerCase());
  out.add(brand.toUpperCase());
  out.add(titleCase(brand));
  // Strip diacritics ("L'Oréal" → "L'Oreal")
  const noDiacritics = brand.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (noDiacritics !== brand) {
    out.add(noDiacritics);
    out.add(noDiacritics.toLowerCase());
    out.add(titleCase(noDiacritics));
  }
  return [...out];
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// --------------------------------------------------------------------------
// Match scoring
// --------------------------------------------------------------------------
// Generic filler words. Stripped from token-overlap scoring so "hydrating"
// alone doesn't make a shampoo look like a toner.
const STOP = new Set([
  'for', 'and', 'with', 'the', 'a', 'an', 'of', 'in', 'on', 'to', 'at', 'by', 'or',
  'oz', 'ml', 'fl', 'gram', 'grams', 'pack', 'count', 'ct',
  'new', 'authentic', 'original', 'daily', 'use', 'all', 'your',
  'hydrating', 'moisturizing', 'soothing', 'gentle', 'natural', 'sensitive',
  'fragrance', 'free', 'alcohol-free', 'unscented',
]);

// Product-type tokens. Synonyms map alternate spellings to a canonical
// category. STRICT type lock: if the source product has any identifiable
// type, the candidate MUST share at least one. Candidates with no extracted
// type are rejected when source has one (prevents toner→ointment matches).
const TYPE_SYNONYMS = {
  toner: 'toner', astringent: 'toner', pad: 'toner', pads: 'toner', mist: 'toner',
  cleanser: 'cleanser', wash: 'cleanser', cleansing: 'cleanser', foam: 'cleanser', cleanse: 'cleanser',
  serum: 'serum', ampoule: 'serum', booster: 'serum', essence: 'serum', drops: 'serum',
  moisturizer: 'moisturizer', cream: 'moisturizer', lotion: 'moisturizer', balm: 'moisturizer',
  ointment: 'moisturizer', emulsion: 'moisturizer',
  mask: 'mask', masks: 'mask',
  spray: 'spray',
  exfoliant: 'exfoliant', exfoliator: 'exfoliant', exfoliating: 'exfoliant',
  scrub: 'exfoliant', peeling: 'exfoliant', peel: 'exfoliant',
  sunscreen: 'sunscreen', spf: 'sunscreen', sunblock: 'sunscreen',
  shampoo: 'shampoo', conditioner: 'shampoo',
  oil: 'oil',
  eye: 'eye',
  gel: 'gel',
  primer: 'primer',
  treatment: 'treatment',
};

function extractType(name) {
  const tokens = (name || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  const types = new Set();
  for (const t of tokens) if (TYPE_SYNONYMS[t]) types.add(TYPE_SYNONYMS[t]);
  return types;
}

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s.\-+%]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !TYPE_SYNONYMS[t]);
}

function scoreMatch(productName, candidateName) {
  const aTokens = new Set(tokenize(productName));
  const bTokens = new Set(tokenize(candidateName));
  let hits = 0;
  for (const t of aTokens) if (bTokens.has(t)) hits += 1;

  const aTypes = extractType(productName);
  const bTypes = extractType(candidateName);
  // STRICT type lock: if source has an identifiable type, candidate MUST share
  // at least one. Otherwise we end up matching "toner" to "ointment".
  let typeOk = true;
  let typeBonus = 0;
  if (aTypes.size > 0) {
    if (bTypes.size === 0) {
      typeOk = false;
    } else {
      const overlap = [...aTypes].some((t) => bTypes.has(t));
      typeOk = overlap;
      if (overlap) typeBonus = 3;
    }
  }
  return { hits, typeOk, typeBonus, aSize: aTokens.size, bSize: bTokens.size };
}

function pickBestMatch(items, productName) {
  const scored = items
    .map((it) => {
      const s = scoreMatch(productName, it.Name || '');
      return {
        it,
        ...s,
        score: s.hits + s.typeBonus,
        price: parseFloat(it.CurrentPrice) || Infinity,
        inStock: (it.StockAvailability || '').toLowerCase() === 'instock',
      };
    })
    .filter((x) => x.typeOk && x.hits >= MIN_OVERLAP);

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;       // best score wins
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return a.price - b.price;
  });
  return scored[0];
}

// --------------------------------------------------------------------------
// Strapi
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
    throw new Error(`Strapi ${init.method || 'GET'} ${path} → ${r.status}: ${txt.slice(0, 200)}`);
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

async function updateProduct(documentId, patch) {
  if (DRY_RUN) return;
  await strapi(`/api/bls-products/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: patch }),
  });
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
async function main() {
  console.log(`▶ syncing Walmart prices via Impact${DRY_RUN ? ' (DRY RUN)' : ''}`);
  let processed = 0, matched = 0, skipped = 0, unmatched = 0, errored = 0, noBrand = 0;

  for await (const p of iterateProducts()) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    processed += 1;

    const { documentId, name, brand, slug, walmartLastSyncAt } = p;
    if (ONLY_MISSING && walmartLastSyncAt) {
      const ageMs = Date.now() - new Date(walmartLastSyncAt).getTime();
      if (ageMs < 24 * 3600 * 1000) {
        skipped += 1;
        continue;
      }
    }
    if (!brand) {
      console.log(`  ? ${slug}: no brand on product`);
      noBrand += 1;
      continue;
    }

    try {
      const items = await getCatalogItemsForBrand(brand);
      if (items.length === 0) {
        console.log(`  ✗ ${slug}: no Walmart items for brand "${brand}"`);
        unmatched += 1;
        continue;
      }
      const best = pickBestMatch(items, name);
      if (!best) {
        if (VERBOSE) {
          const top = items.slice(0, 3).map((i) => `"${i.Name?.slice(0, 60)}"`).join(', ');
          console.log(`    [${slug}] ${items.length} brand items, top: ${top}`);
        }
        console.log(`  ✗ ${slug}: no match in ${items.length} "${brand}" items`);
        unmatched += 1;
        continue;
      }
      const price = best.price;
      const url = best.it.Url;
      // Strapi field cap: walmartUrl varchar(500)
      if (url && url.length > 500) {
        console.log(`  ! ${slug}: walmart URL > 500 chars, skipping`);
        errored += 1;
        continue;
      }
      console.log(`  ✓ ${slug}: $${price.toFixed(2)} hits=${best.hits} ← "${(best.it.Name || '').slice(0, 60)}…"`);
      await updateProduct(documentId, {
        walmartPrice: price,
        walmartUrl: url,
        walmartLastSyncAt: new Date().toISOString(),
      });
      await recordPriceSnapshot({
        productDocumentId: documentId,
        merchant: 'walmart',
        price,
        currency: 'USD',
        available: best.inStock,
      });
      matched += 1;
    } catch (err) {
      console.error(`  ! ${slug}: ${err.message}`);
      errored += 1;
    }
  }

  console.log(
    `\nDone. processed=${processed} matched=${matched} unmatched=${unmatched} ` +
    `noBrand=${noBrand} skipped=${skipped} errored=${errored}`,
  );
  console.log(`Brand cache: ${brandCache.size} unique brands queried`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
