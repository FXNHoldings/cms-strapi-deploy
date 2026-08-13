#!/usr/bin/env node
// Attach offers from additional merchants to products already imported from a
// canonical source (default: amazon). The product's name/description/specs are
// never overwritten — matched listings only become offers on the same product,
// so product info stays consistent with the source it was imported from.
//
// Workflow: import products from ONE merchant in the sourcing UI first, then
// run this script to find the same products at the other merchants.
//
// Merchants are discovered from the app's active merchant list, so adding a
// new merchant to the sourcing app automatically includes it here. Use
// --merchants=... to restrict the set, or edit EXCLUDED_MERCHANTS below.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API_BASE = process.env.SOURCING_API_BASE || 'http://127.0.0.1:3005';

// Merchants never searched for extra offers (bad feeds, duplicates, etc.).
// Edit this list as your merchant lineup grows.
const EXCLUDED_MERCHANTS = [];

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, ...parts] = arg.slice(2).split('=');
    return [key, parts.length ? parts.join('=') : true];
  }),
);

if (args.help || args.h) {
  console.log(`Usage:
  node scripts/match-merchant-offers.mjs --limit=10
  node scripts/match-merchant-offers.mjs --limit=10 --write
  node scripts/match-merchant-offers.mjs --product=pixel-8 --merchants=walmart,ebay --write

Options:
  --source=amazon              Canonical source merchant (its products are the match targets).
  --merchants=walmart,ebay     Merchants to search. Default: all active merchants except source.
  --product=<text>             Only products whose name or slug contains this text.
  --limit=25                   Max products to process (default 25).
  --offset=0                   Skip this many products.
  --per-merchant-limit=5       Search results fetched per merchant (default 5).
  --min-score=6                Minimum match score before attaching (default 6).
  --write                      Attach offers in Strapi. Default is dry-run (report only).
`);
  process.exit(0);
}

const sourceMerchant = typeof args.source === 'string' ? args.source : 'amazon';
const write = Boolean(args.write);
const limit = numberArg('limit', 25);
const offset = numberArg('offset', 0);
const perMerchantLimit = numberArg('per-merchant-limit', 5);
const minScore = numberArg('min-score', 6);
const productFilter = typeof args.product === 'string' ? args.product.toLowerCase() : '';

const env = loadEnvLocal();
const STRAPI_URL = (env.STRAPI_URL || process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const STRAPI_API_TOKEN = env.STRAPI_API_TOKEN || process.env.STRAPI_API_TOKEN || '';
if (!STRAPI_API_TOKEN) {
  console.error('STRAPI_API_TOKEN not found in .env.local or environment.');
  process.exit(1);
}

function numberArg(name, fallback) {
  const value = Number(args[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function loadEnvLocal() {
  const file = join(ROOT, '.env.local');
  if (!existsSync(file)) return {};
  const entries = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) entries[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return entries;
}

function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreResult(product, item) {
  const productName = normalizedText(product.name);
  const resultName = normalizedText(item.productName);
  if (!productName || !resultName) return { score: -100, reason: 'missing name' };

  // Brand mismatch is disqualifying when both sides declare one.
  const productBrand = normalizedText(product.brand);
  const resultBrand = normalizedText(item.brand);
  if (productBrand && resultBrand && productBrand !== resultBrand && !resultName.includes(productBrand)) {
    return { score: -100, reason: `brand mismatch (${item.brand})` };
  }

  let score = 0;
  const reasons = [];

  // Identifier equality is the strongest signal.
  const productSku = normalizedText(product.sku);
  const ids = [item.gtin, item.asin, item.mpn, item.sku, item.merchantSku].map(normalizedText);
  if (productSku && ids.includes(productSku)) {
    score += 10;
    reasons.push('identifier match');
  }

  // Token overlap: how much of the product name appears in the result name.
  const productTokens = productName.split(' ').filter((token) => token.length > 1);
  const resultTokens = new Set(resultName.split(' '));
  const overlap = productTokens.filter((token) => resultTokens.has(token)).length;
  const coverage = productTokens.length ? overlap / productTokens.length : 0;
  score += Math.round(coverage * 8);
  reasons.push(`${Math.round(coverage * 100)}% name coverage`);

  // Price sanity vs the product's existing offers (guards against accessories).
  const knownPrices = (product.offers || [])
    .map((offer) => Number(offer.price))
    .filter((price) => Number.isFinite(price) && price > 0);
  if (knownPrices.length && Number.isFinite(item.price) && item.price > 0) {
    const median = knownPrices.sort((a, b) => a - b)[Math.floor(knownPrices.length / 2)];
    const ratio = item.price / median;
    if (ratio < 0.4 || ratio > 2.5) {
      score -= 6;
      reasons.push(`price outlier (${item.currency} ${item.price} vs ~${median})`);
    } else {
      score += 1;
    }
  }

  // Used/refurb/open-box listings are not comparable offers for a new product;
  // penalize below the default threshold unless the name match is very strong.
  // Merchant condition metadata is unreliable (Walmart reports "Open Box"
  // titles as new), so also check the listing title.
  const usedTitle = /\b(open box|refurbished|renewed|pre[- ]?owned|used)\b/.test(resultName);
  if (usedTitle || (item.condition !== 'new' && item.condition !== 'unknown')) {
    score -= 4;
    reasons.push(usedTitle ? 'used/open-box title' : item.condition);
  } else {
    score += 1;
  }

  return { score, reason: reasons.join(', ') };
}

async function appFetch(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `${path} failed: HTTP ${response.status}`);
  return data;
}

async function fetchProducts() {
  const products = [];
  let page = 1;
  while (products.length < offset + limit) {
    const params = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'fields[0]': 'name',
      'fields[1]': 'slug',
      'fields[2]': 'brand',
      'fields[3]': 'sku',
      'filters[productStatus][$eq]': 'active',
      'populate[offers][fields][0]': 'price',
      'populate[offers][populate][merchant][fields][0]': 'slug',
      'sort[0]': 'createdAt:desc',
    });
    const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params}`, {
      headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    });
    if (!response.ok) throw new Error(`Strapi product list failed: HTTP ${response.status}`);
    const json = await response.json();
    const rows = json?.data ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      if (productFilter) {
        const haystack = `${row.name || ''} ${row.slug || ''}`.toLowerCase();
        if (!haystack.includes(productFilter)) continue;
      }
      products.push(row);
    }
    if (rows.length < 100) break;
    page += 1;
  }
  return products.slice(offset, offset + limit);
}

async function main() {
  const merchantsData = await appFetch('/api/merchants');
  const activeMerchants = (merchantsData.merchants || []).map((merchant) => merchant.slug);
  const requested = typeof args.merchants === 'string' ? args.merchants.split(',').map((slug) => slug.trim()) : null;
  const searchMerchants = (requested || activeMerchants).filter(
    (slug) => slug && slug !== sourceMerchant && !EXCLUDED_MERCHANTS.includes(slug),
  );
  if (!searchMerchants.length) {
    console.error('No merchants to search after exclusions.');
    process.exit(1);
  }

  const products = await fetchProducts();
  console.log(`${write ? 'WRITE' : 'DRY RUN'} — ${products.length} product(s), searching: ${searchMerchants.join(', ')}\n`);

  let attached = 0;
  let skipped = 0;
  for (const product of products) {
    const existingSlugs = new Set(
      (product.offers || []).map((offer) => offer.merchant?.slug).filter(Boolean),
    );
    const missing = searchMerchants.filter((slug) => !existingSlugs.has(slug));
    if (!missing.length) {
      console.log(`= ${product.name} — all merchants already have offers`);
      continue;
    }

    let results;
    try {
      const searchResponse = await appFetch('/api/search', {
        keyword: product.name,
        merchants: missing,
        filters: { productType: 'all', excludeAccessories: true, perMerchantLimit, sortBy: 'relevance' },
      });
      results = searchResponse.results || [];
    } catch (error) {
      console.log(`! ${product.name} — search failed: ${error.message}`);
      continue;
    }

    for (const slug of missing) {
      const candidates = results
        .filter((item) => item.merchantSlug === slug && item.confidence !== 'demo')
        .map((item) => ({ item, ...scoreResult(product, item) }))
        .sort((left, right) => right.score - left.score);
      const best = candidates[0];
      if (!best || best.score < minScore) {
        skipped += 1;
        const note = best ? `best score ${best.score} (${best.reason})` : 'no live results';
        console.log(`- ${product.name} @ ${slug}: skipped — ${note}`);
        continue;
      }

      console.log(
        `+ ${product.name} @ ${slug}: "${best.item.productName}" ` +
          `${best.item.currency} ${best.item.price ?? '?'} [score ${best.score}: ${best.reason}]`,
      );
      if (!write) continue;
      try {
        await appFetch('/api/add-to-strapi', {
          item: best.item,
          dryRun: false,
          // Never touch the canonical product details imported from the source.
          importSpecs: false,
          importDescription: false,
          overwriteProductDetails: false,
          targetProductDocumentId: product.documentId,
        });
        attached += 1;
      } catch (error) {
        console.log(`! ${product.name} @ ${slug}: attach failed — ${error.message}`);
      }
    }
  }

  console.log(`\nDone. ${write ? `${attached} offer(s) attached` : 'Dry run only — rerun with --write to attach'}, ${skipped} candidate slot(s) skipped.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
