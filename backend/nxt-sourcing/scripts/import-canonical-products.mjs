#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API_BASE = process.env.SOURCING_API_BASE || 'http://127.0.0.1:3005';
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, ...parts] = arg.slice(2).split('=');
    return [key, parts.length ? parts.join('=') : true];
  }),
);

if (args.help || args.h) {
  console.log(`Usage:
  node scripts/import-canonical-products.mjs --file=smartphones.json --limit=10
  node scripts/import-canonical-products.mjs --file=smartphones.json --write --category="Smart Phones" --storefront=nxt-bargains

Options:
  --file=smartphones.json              Canonical file in data/canonical-products
  --limit=20                           Max variants to process
  --offset=0                           Skip this many variants
  --brand=Apple                        Optional brand filter
  --category="Smart Phones"            Strapi category override
  --storefront=nxt-bargains            nxt-bargains or bestlooking-skin
  --merchants=amazon,ebay,walmart      Comma-separated source slugs. Default: all configured merchants.
  --per-merchant-limit=3               Search result limit per merchant.
  --write                              Write to Strapi. Default is dry-run.
  --import-specs                       Import product specifications. Default true.
  --no-import-specs                    Do not import product specifications.
  --import-description                 Import merchant description. Default true.
  --no-import-description              Do not import merchant description.
  --overwrite-existing-details         Overwrite existing product details. Default true.
  --no-overwrite-existing-details      Do not overwrite existing product details.
  --skip-imported                      Skip rows already marked imported in import-cache.json.
  --cache-file=import-cache.json       Cache file inside data/canonical-products.
  --min-score=8                        Minimum match score before import.
`);
  process.exit(0);
}

const fileName = String(args.file || 'smartphones.json');
const filePath = join(ROOT, 'data', 'canonical-products', fileName);
const defaultMerchantSlugs = ['amazon', 'ebay', 'walmart', 'newegg', 'target', 'best-buy'];
const limit = numberArg('limit', 10);
const offset = numberArg('offset', 0);
const minScore = numberArg('min-score', 8);
const perMerchantLimit = numberArg('per-merchant-limit', 3);
const searchProductType = fileName.toLowerCase() === 'smartphones.json' ? 'phones' : 'all';
const brandFilter = stringArg('brand').toLowerCase();
const categoryName = stringArg('category') || 'Smart Phones';
const storefront = stringArg('storefront') || 'nxt-bargains';
const merchants = (stringArg('merchants') || defaultMerchantSlugs.join(',')).split(',').map((item) => item.trim()).filter(Boolean);
const dryRun = args.write !== true;
const importSpecs = args['no-import-specs'] === true ? false : args['import-specs'] !== false;
const importDescription = args['no-import-description'] === true ? false : args['import-description'] !== false;
const overwriteProductDetails = args['no-overwrite-existing-details'] === true ? false : args['overwrite-existing-details'] !== false;
const skipImported = args['skip-imported'] === true;
const cacheFileName = stringArg('cache-file') || 'import-cache.json';
const cachePath = join(ROOT, 'data', 'canonical-products', cacheFileName);
const canonicalProductNamesForSearchImport = [];

if (!existsSync(filePath)) {
  console.error(`Canonical file not found: ${filePath}`);
  process.exit(1);
}

function numberArg(key, fallback) {
  const value = Number(args[key]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function stringArg(key) {
  return typeof args[key] === 'string' ? String(args[key]).trim() : '';
}

function loadVariants() {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const rows = [];
  for (const family of data.families || []) {
    for (const variant of family.variants || []) {
      rows.push({
        category: data.category || family.category || '',
        brand: family.brand || '',
        family: family.family || '',
        ...variant,
      });
    }
  }
  const prioritizedProductNames = fileName.toLowerCase() === 'smartphones.json'
    ? canonicalProductNamesForSearchImport
    : [];
  for (const variant of prioritizedProductNames.map(canonicalVariantFromProductName)) {
    const exists = rows.some((row) => variantKey(row) === variantKey(variant));
    if (!exists) rows.push(variant);
  }
  const requestedOrder = new Map(
    prioritizedProductNames
      .map(canonicalVariantFromProductName)
      .map((variant, index) => [variantKey(variant), index]),
  );

  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftOrder = requestedOrder.get(variantKey(left.row));
      const rightOrder = requestedOrder.get(variantKey(right.row));
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ row }) => row)
    .filter((row) => !brandFilter || String(row.brand).toLowerCase() === brandFilter)
    .slice(offset, offset + limit);
}

function canonicalVariantFromProductName(productName) {
  const name = String(productName || '').trim();
  const brand = brandFromProductName(name);
  const model = modelFromProductName(name, brand);
  const canonicalName = brand === 'Apple' ? `Apple ${model}` : name;
  const requiredTerms = significantModelTerms(model);
  return {
    category: 'Smartphones',
    brand,
    family: familyFromBrand(brand),
    canonicalName,
    model,
    identifierStatus: 'needs_verification',
    identifiers: {},
    requiredTerms,
    excludeTerms: ['case', 'refurbished', 'renewed', 'used'],
    searchQueries: [
      `${canonicalName} unlocked`,
      `${canonicalName} new unlocked`,
    ],
    variantsToSplitLater: ['storage', 'color', 'carrier', 'region'],
  };
}

function brandFromProductName(productName) {
  if (productName.startsWith('Samsung ')) return 'Samsung';
  if (productName.startsWith('Google ')) return 'Google';
  return 'Apple';
}

function modelFromProductName(productName, brand) {
  return productName.replace(new RegExp(`^${brand}\\s+`, 'i'), '').trim();
}

function familyFromBrand(brand) {
  if (brand === 'Samsung') return 'Galaxy S';
  if (brand === 'Google') return 'Pixel';
  return 'iPhone';
}

function significantModelTerms(model) {
  return normalizedText(model)
    .split(/\s+/)
    .filter((term) => term && !['galaxy', 'pixel'].includes(term));
}

function variantKey(variant) {
  return [variant.brand, variant.family, variant.canonicalName].map(normalizedText).join('::');
}

function cacheKeyFor(variant) {
  return [fileName, variant.brand, variant.family, variant.canonicalName].filter(Boolean).join('::');
}

function loadCache() {
  if (!existsSync(cachePath)) {
    return { schemaVersion: 1, imported: {}, checked: {}, skipped: {} };
  }
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    return {
      schemaVersion: 1,
      imported: isPlainObject(cache.imported) ? cache.imported : {},
      checked: isPlainObject(cache.checked) ? cache.checked : {},
      skipped: isPlainObject(cache.skipped) ? cache.skipped : {},
    };
  } catch {
    return { schemaVersion: 1, imported: {}, checked: {}, skipped: {} };
  }
}

function saveCache(cache) {
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function postJson(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.message || json.error || `${path} failed with HTTP ${response.status}`);
  }
  return json;
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
}

function incompatibleTermsFor(variant) {
  const model = normalizedText(variant.model);
  const terms = ['fair condition', 'good condition', 'acceptable condition', 'pre owned', 'preowned', 'parts'];
  const storageOptions = ['128gb', '256gb', '512gb', '1tb', '2tb'];
  const storage = normalizedText(variant.storage);
  if (storage) {
    terms.push(...storageOptions.filter((option) => option !== storage));
  }

  if (model.includes('iphone')) {
    if (!model.includes('plus')) terms.push('plus');
    if (!model.includes('pro')) terms.push('pro');
    if (!model.includes('pro max')) terms.push('pro max');
    if (!model.includes('air')) terms.push('air');
    if (!model.match(/iphone\s+\d+e/)) terms.push('16e', '17e');
  }

  if (model.includes('pixel')) {
    if (!model.includes('pro')) terms.push('pro');
    if (!model.includes('pro xl')) terms.push('pro xl', 'xl');
    if (!model.includes('fold')) terms.push('fold');
    if (!model.match(/pixel\s+\d+a/)) terms.push('7a', '8a', '9a', '10a');
  }

  if (model.includes('galaxy')) {
    const series = model.match(/\bs\d{2}\b/)?.[0];
    if (series && !model.includes('+')) terms.push(`${series}+`);
    if (!model.includes('ultra')) terms.push('ultra');
    if (!model.includes('fe')) terms.push('fe');
    if (!model.includes('edge')) terms.push('edge');
  }

  return terms;
}

function scoreResult(variant, item) {
  const haystack = normalizedText([
    item.productName,
    item.brand,
    item.category,
    item.shortDescription,
    item.merchantName,
    item.condition,
  ].filter(Boolean).join(' '));
  const required = variant.requiredTerms || [];
  const excludes = [...(variant.excludeTerms || []), ...((variant.globalExcludeTerms || [])), ...incompatibleTermsFor(variant)];
  const missing = required.filter((term) => !haystack.includes(normalizedText(term)));
  const blocked = excludes.filter((term) => haystack.includes(normalizedText(term)));
  let score = 0;
  score += required.length - missing.length;
  if (normalizedText(item.productName).includes(normalizedText(variant.model))) score += 4;
  if (variant.storage && haystack.includes(normalizedText(variant.storage))) score += 3;
  if (item.condition === 'new' || item.condition === 'unknown') score += 1;
  if (item.price) score += 1;
  if (item.imageUrl) score += 1;
  score -= blocked.length * 5;
  score -= missing.length * 3;
  return { score, missing, blocked };
}

function bestRejectedMatch(matches) {
  return matches
    .slice()
    .sort((left, right) => right.score - left.score)[0] || null;
}

async function findAllScoredMatches(variant) {
  const queries = variant.searchQueries?.length ? variant.searchQueries : [variant.canonicalName];
  const matches = [];
  const seenUrls = new Set();

  for (const query of queries) {
    const search = await postJson('/api/search', {
      keyword: query,
      merchants,
      filters: {
        productType: searchProductType,
        excludeAccessories: true,
        perMerchantLimit,
        sortBy: 'relevance',
      },
    });

    for (const item of search.results || []) {
      const urlKey = String(item.productUrl || item.affiliateUrl || `${item.merchantSlug}:${item.productName}`).toLowerCase();
      if (seenUrls.has(urlKey)) continue;
      seenUrls.add(urlKey);
      const scored = scoreResult(variant, item);
      matches.push({ query, item, ...scored });
    }
  }

  const countsByMerchant = new Map();
  const accepted = [];
  for (const match of matches
    .filter((item) => item.score >= minScore && !item.blocked.length && !item.missing.length)
    .sort((left, right) => right.score - left.score)) {
    const merchant = match.item.merchantSlug || match.item.merchantName || 'unknown';
    const count = countsByMerchant.get(merchant) || 0;
    if (count >= perMerchantLimit) continue;
    countsByMerchant.set(merchant, count + 1);
    accepted.push(match);
  }

  return { accepted, rejectedBest: bestRejectedMatch(matches) };
}

async function importMatch(match, targetProductDocumentId) {
  return postJson('/api/add-to-strapi', {
    item: match.item,
    dryRun,
    importSpecs,
    importDescription,
    overwriteProductDetails,
    storefront,
    categoryName,
    targetProductDocumentId,
  });
}

function matchSummary(match) {
  return {
    query: match.query,
    score: match.score,
    merchantName: match.item.merchantName,
    merchantSlug: match.item.merchantSlug,
    matchedProductName: match.item.productName,
    matchedProductUrl: match.item.productUrl,
  };
}

async function importCombinedMatches(matches) {
  let targetProductDocumentId;
  const results = [];

  for (const match of matches) {
    const result = await importMatch(match, targetProductDocumentId);
    if (!targetProductDocumentId && result.product?.documentId) {
      targetProductDocumentId = result.product.documentId;
    }
    results.push({ match, result });
  }

  return {
    results,
    targetProductDocumentId,
  };
}

async function findImportableMatches(variant) {
  const { accepted, rejectedBest } = await findAllScoredMatches(variant);
  if (accepted.length) {
    return { matches: accepted, rejectedBest };
  }
  return { matches: [], rejectedBest };
}

async function main() {
  const variants = loadVariants();
  console.log(`${dryRun ? 'Dry run' : 'Live write'}: ${variants.length} canonical product(s) from ${fileName}`);
  console.log(`storefront=${storefront} category=${categoryName || '(detected)'} importSpecs=${importSpecs} importDescription=${importDescription} overwrite=${overwriteProductDetails}`);
  console.log(`merchants=${merchants.join(',')}`);
  console.log(`cache=${cachePath}${skipImported ? ' skipImported=true' : ''}`);

  let saved = 0;
  let skipped = 0;
  let cached = 0;
  const cache = loadCache();

  for (const variant of variants) {
    try {
      const cacheKey = cacheKeyFor(variant);
      if (skipImported && cache.imported[cacheKey]) {
        skipped += 1;
        cached += 1;
        console.log(`CACHE ${variant.canonicalName}: already imported at ${cache.imported[cacheKey].importedAt || 'unknown time'}`);
        continue;
      }

      const { matches, rejectedBest } = await findImportableMatches(variant);
      if (!matches.length) {
        skipped += 1;
        cache.skipped[cacheKey] = {
          canonicalName: variant.canonicalName,
          skippedAt: new Date().toISOString(),
          reason: !rejectedBest ? 'no_match' : 'low_confidence',
          score: rejectedBest?.score ?? 0,
          missing: rejectedBest?.missing ?? [],
          blocked: rejectedBest?.blocked ?? [],
          query: rejectedBest?.query,
          matchedProductName: rejectedBest?.item?.productName,
          merchantName: rejectedBest?.item?.merchantName,
        };
        saveCache(cache);
        console.log(`SKIP ${variant.canonicalName}: score=${rejectedBest?.score ?? 0} missing=${rejectedBest?.missing?.join(',') || '-'} blocked=${rejectedBest?.blocked?.join(',') || '-'}`);
        continue;
      }

      const combined = await importCombinedMatches(matches);
      const first = combined.results[0];
      const lastResult = combined.results[combined.results.length - 1]?.result || first?.result || {};

      saved += combined.results.length;
      const cacheEntry = {
        canonicalName: variant.canonicalName,
        brand: variant.brand,
        family: variant.family,
        model: variant.model,
        storage: variant.storage,
        query: first?.match.query,
        score: first?.match.score,
        merchantName: first?.match.item.merchantName,
        merchantSlug: first?.match.item.merchantSlug,
        matchedProductName: first?.match.item.productName,
        matchedProductUrl: first?.match.item.productUrl,
        matchedOffers: combined.results.map(({ match }) => matchSummary(match)),
        storefront,
        categoryName,
        dryRun,
        checkedAt: new Date().toISOString(),
        message: lastResult.message,
        strapiProductDocumentId: combined.targetProductDocumentId || lastResult.product?.documentId,
        strapiOfferDocumentIds: combined.results.map(({ result }) => result.offer?.documentId).filter(Boolean),
        strapiSnapshotDocumentIds: combined.results.map(({ result }) => result.snapshot?.documentId).filter(Boolean),
      };
      cache.checked[cacheKey] = cacheEntry;
      if (!dryRun) {
        cache.imported[cacheKey] = { ...cacheEntry, importedAt: new Date().toISOString() };
        delete cache.skipped[cacheKey];
      }
      saveCache(cache);
      console.log(`${dryRun ? 'OK' : 'SAVED'} ${variant.canonicalName}: ${combined.results.length} offer(s) combined into ${first?.match.item.productName} - ${lastResult.message}`);
    } catch (error) {
      skipped += 1;
      console.log(`ERROR ${variant.canonicalName}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(`Done. ${dryRun ? 'checked' : 'saved'}=${saved} skipped=${skipped} cached=${cached}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
