#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, '..');

loadEnv(path.join(APP_DIR, '.env.local'));

const args = parseArgs(process.argv.slice(2));

console.error('fetch-product-price-history.mjs is disabled because the provider history data was unreliable. No changes were made.');
console.error('Re-enable this script only after choosing a verified price-history provider.');
process.exit(1);

const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';
const RAPIDAPI_KEY = process.env.RAPIDAPI_PRODUCT_SEARCH_KEY || process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = process.env.RAPIDAPI_PRODUCT_SEARCH_HOST || 'real-time-product-search.p.rapidapi.com';
const RAPIDAPI_SEARCH_PATH = normalizeApiPath(process.env.RAPIDAPI_PRODUCT_SEARCH_PATH || '/search-v2');
const OPENWEBNINJA_API_KEY = process.env.OPENWEBNINJA_API_KEY || process.env.OPENWEB_NINJA_API_KEY || '';
const OPENWEBNINJA_BASE_URL = (process.env.OPENWEBNINJA_PRODUCT_SEARCH_BASE_URL || 'https://api.openwebninja.com/realtime-product-search/v2').replace(/\/$/, '');
const HISTORY_PROVIDER = stringValue(args.historyProvider || process.env.PRICE_HISTORY_PROVIDER || 'rapidapi').toLowerCase();
const USE_OPENWEBNINJA_HISTORY = HISTORY_PROVIDER === 'openwebninja' || HISTORY_PROVIDER === 'openweb';
const DEFAULT_HISTORY_PATH = USE_OPENWEBNINJA_HISTORY ? '/product-price-history-v2' : '/product-price-history';
const RAPIDAPI_HISTORY_PATH = normalizeApiPath(
  process.env.RAPIDAPI_PRODUCT_SEARCH_HISTORY_PATH
    || process.env.OPENWEBNINJA_PRODUCT_SEARCH_HISTORY_PATH
    || DEFAULT_HISTORY_PATH,
);
const COUNTRY = process.env.RAPIDAPI_PRODUCT_SEARCH_COUNTRY || 'us';
const LANGUAGE = process.env.RAPIDAPI_PRODUCT_SEARCH_LANGUAGE || 'en';
const SORT_BY = process.env.RAPIDAPI_PRODUCT_SEARCH_SORT_BY || 'BEST_MATCH';
const DEFAULT_MERCHANT_SLUGS = 'amazon,ebay,walmart,target,best-buy,newegg';
const MERCHANT_SLUGS = splitList(process.env.PRICE_HISTORY_MERCHANT_SLUGS || DEFAULT_MERCHANT_SLUGS);
const SOURCE = 'product-search-price-history';

const dryRun = !args.write;
const limit = positiveInt(args.limit || process.env.PRICE_HISTORY_REFRESH_LIMIT, 25);
const pageSize = positiveInt(process.env.PRICE_HISTORY_REFRESH_POOL_SIZE, Math.max(limit, 100));
const perProductLimit = positiveInt(args.perProductLimit || process.env.PRICE_HISTORY_PRODUCT_SEARCH_LIMIT, 10);
const maxSnapshotsPerProduct = positiveInt(
  args.maxSnapshotsPerProduct || process.env.PRICE_HISTORY_MAX_SNAPSHOTS_PER_PRODUCT,
  80,
);
const matchThreshold = Number(args.matchThreshold || process.env.PRICE_HISTORY_MATCH_THRESHOLD || 6);
const requestDelayMs = positiveInt(process.env.PRICE_HISTORY_REQUEST_DELAY_MS, 750);
const historyMonths = positiveInt(args.historyMonths || process.env.PRICE_HISTORY_MONTHS, 6);
const historySince = monthsAgo(historyMonths);
const historyPages = positiveInt(args.historyPages || process.env.PRICE_HISTORY_PAGES, 1);

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is not set.');
if (!RAPIDAPI_KEY) fail('RAPIDAPI_PRODUCT_SEARCH_KEY or RAPIDAPI_KEY is not set.');

const summary = {
  dryRun,
  processed: 0,
  apiRequests: 0,
  offersCreated: 0,
  offersUpdated: 0,
  snapshotsCreated: 0,
  snapshotsSkipped: 0,
  productsSkipped: 0,
  errors: 0,
  historyMonths,
  historyPages,
};

console.log(`NXT.Bargains price-history refresh`);
console.log(`API: ${RAPIDAPI_HOST}${RAPIDAPI_SEARCH_PATH} | dry-run: ${dryRun} | limit: ${limit}`);
console.log(`History window: last ${historyMonths} month(s)`);
console.log(`History API: ${historyApiLabel()} | pages per product: ${historyPages}`);
console.log(`Merchants: ${MERCHANT_SLUGS.join(', ')}`);

try {
  await main();
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error?.stack || error);
  process.exit(1);
}

async function main() {
  let page = 1;

  while (summary.processed < limit) {
    const products = await listProducts(page, pageSize);
    if (!products.rows.length) break;

    for (const product of products.rows) {
      if (summary.processed >= limit) break;
      summary.processed += 1;

      try {
        const name = stringValue(product.name);
        if (!name) {
          summary.productsSkipped += 1;
          continue;
        }

        console.log(`[${summary.processed}/${limit}] ${name}`);
        const apiProducts = await searchProductOffers(product);
        summary.apiRequests += 1;
        if (requestDelayMs > 0) await delay(requestDelayMs);

        const historyProducts = await maybeFetchHistoryProducts(apiProducts);
        const matches = bestOfferMatches(product, [...apiProducts, ...historyProducts]);

        if (!matches.length) {
          console.log('  no matching merchant offers found');
          summary.productsSkipped += 1;
          continue;
        }

        let productSnapshots = 0;
        for (const match of matches) {
          const merchant = await ensureMerchant(match.offer);
          const offer = await upsertOffer(product, merchant, match.offer);
          const snapshots = snapshotsFromOffer(match.offer);

          for (const snapshot of snapshots) {
            if (productSnapshots >= maxSnapshotsPerProduct) break;
            const created = await createSnapshotOnce(product, merchant, offer, snapshot, match.offer);
            if (created) {
              summary.snapshotsCreated += 1;
              productSnapshots += 1;
            } else {
              summary.snapshotsSkipped += 1;
            }
          }
        }

        console.log(`  matched ${matches.length} offer(s), created ${productSnapshots} snapshot(s)`);
      } catch (error) {
        summary.errors += 1;
        console.error(`  error: ${error.message}`);
      }
    }

    if (page >= products.pageCount) break;
    page += 1;
  }
}

async function listProducts(page, pageSize) {
  const params = new URLSearchParams({
    'pagination[page]': String(page),
    'pagination[pageSize]': String(pageSize),
    'fields[0]': 'name',
    'fields[1]': 'slug',
    'fields[2]': 'brand',
    'fields[3]': 'asin',
    'fields[4]': 'gtin',
    'fields[5]': 'mpn',
    'fields[6]': 'sku',
    'filters[productStatus][$eq]': 'active',
    'populate[offers][populate][0]': 'merchant',
    'sort[0]': 'updatedAt:desc',
  });
  const json = await strapiGet(`commerce-products?${params.toString()}`);
  return {
    rows: Array.isArray(json?.data) ? json.data : [],
    pageCount: json?.meta?.pagination?.pageCount || 1,
  };
}

async function searchProductOffers(product) {
  const params = new URLSearchParams({
    q: searchQuery(product),
    country: COUNTRY,
    language: LANGUAGE,
    page: '1',
    limit: String(perProductLimit),
    sort_by: SORT_BY,
  });
  const payload = await rapidApiGet(`${RAPIDAPI_SEARCH_PATH}?${params.toString()}`);
  return productRecordsFromPayload(payload);
}

async function maybeFetchHistoryProducts(products) {
  if (!RAPIDAPI_HISTORY_PATH) return [];

  const productIds = products
    .map((product) => stringValue(product.product_id || product.productId || product.id))
    .filter(Boolean)
    .slice(0, 3);

  const rows = [];
  for (const productId of productIds) {
    for (let page = 1; page <= historyPages; page += 1) {
      const params = new URLSearchParams({
        product_id: productId,
        page: String(page),
        country: COUNTRY,
        language: LANGUAGE,
      });
      try {
        rows.push(...productRecordsFromPayload(await historyApiGet(`${RAPIDAPI_HISTORY_PATH}?${params.toString()}`)));
        summary.apiRequests += 1;
        if (requestDelayMs > 0) await delay(requestDelayMs);
      } catch (error) {
        console.error(`  history endpoint skipped for ${productId} page ${page}: ${error.message}`);
        break;
      }
    }
  }
  return rows;
}

function bestOfferMatches(product, apiProducts) {
  const matches = [];
  const seen = new Set();

  for (const apiProduct of apiProducts) {
    const offers = offerRecordsFromProduct(apiProduct);
    for (const offer of offers) {
      const normalized = normalizeOffer(apiProduct, offer);
      if (!normalized.price || !MERCHANT_SLUGS.includes(normalized.merchantSlug)) continue;

      const key = [
        normalized.merchantSlug,
        normalized.offerId,
        normalized.productUrl,
        normalized.title,
      ].filter(Boolean).join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      const score = matchScore(product, normalized);
      if (score >= matchThreshold) matches.push({ offer: normalized, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, positiveInt(process.env.PRICE_HISTORY_MAX_OFFERS_PER_PRODUCT, 8));
}

function normalizeOffer(product, offer) {
  const merchantName = stringValue(
    offer.store_name || offer.merchant_name || offer.seller || product.store_name || product.merchant_name,
  ) || merchantFromUrl(stringValue(offer.offer_page_url || product.offer_page_url || product.product_page_url));
  const productUrl = stringValue(
    offer.offer_page_url || offer.product_url || offer.url || product.offer_page_url || product.product_page_url,
  );
  const merchantSlug = merchantSlugFor(merchantName, productUrl);
  const price = parsePrice(offer.price ?? product.price);
  const originalPrice = parsePrice(offer.original_price ?? offer.list_price ?? product.original_price);

  return {
    offerId: stringValue(offer.offer_id || offer.id || product.offer_id),
    title: stringValue(offer.offer_title || product.product_title || product.title || product.name),
    productUrl,
    merchantName: merchantName || titleCase(merchantSlug.replace(/-/g, ' ')),
    merchantSlug,
    merchantSku: stringValue(offer.offer_id || offer.sku || product.product_id),
    price,
    originalPrice,
    currency: currencyFromPrice(offer.price ?? product.price) || 'USD',
    availability: availabilityFromOffer(offer),
    condition: conditionFromOffer(offer.product_condition || product.product_condition),
    history: Array.isArray(offer.price_history) ? offer.price_history : [],
    rawPayload: { product, offer },
  };
}

function snapshotsFromOffer(offer) {
  const snapshots = [];
  for (const item of offer.history) {
    if (!item || typeof item !== 'object') continue;
    const price = parsePrice(item.price);
    const checkedAt = dateToIso(item.date || item.checked_at || item.datetime);
    if (!price || !checkedAt) continue;
    if (Date.parse(checkedAt) < historySince.getTime()) continue;
    snapshots.push({
      price,
      originalPrice: offer.originalPrice,
      currency: offer.currency,
      availability: offer.availability,
      checkedAt,
    });
  }

  const today = new Date().toISOString();
  if (offer.price) {
    snapshots.push({
      price: offer.price,
      originalPrice: offer.originalPrice,
      currency: offer.currency,
      availability: offer.availability,
      checkedAt: today,
    });
  }

  return dedupeSnapshots(snapshots).sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
}

async function ensureMerchant(offer) {
  const existing = await findOne('commerce-merchants', { slug: offer.merchantSlug });
  if (existing) return existing;

  const websiteUrl = originFromUrl(offer.productUrl);
  if (dryRun) {
    summary.offersCreated += 0;
    return { documentId: `dry-run-merchant-${offer.merchantSlug}`, name: offer.merchantName, slug: offer.merchantSlug };
  }

  return strapiCreate('commerce-merchants', {
    name: offer.merchantName,
    slug: offer.merchantSlug,
    websiteUrl,
    country: COUNTRY.toUpperCase(),
    merchantStatus: 'active',
    trackingParams: { source: SOURCE },
  });
}

async function upsertOffer(product, merchant, offer) {
  const existing = findExistingOffer(product, merchant, offer)
    || await findOffer(product.documentId, merchant.documentId, offer);
  const data = {
    product: product.documentId,
    merchant: merchant.documentId,
    title: offer.title,
    price: offer.price,
    originalPrice: offer.originalPrice,
    currency: offer.currency,
    discountPercent: discountPercent(offer.price, offer.originalPrice),
    productUrl: offer.productUrl,
    availability: offer.availability,
    condition: offer.condition,
    merchantSku: bounded(offer.merchantSku, 120),
    source: SOURCE,
    lastCheckedAt: new Date().toISOString(),
    status: 'active',
    syncError: undefined,
  };

  if (dryRun) {
    if (existing) summary.offersUpdated += 1;
    else summary.offersCreated += 1;
    return existing || { documentId: `dry-run-offer-${offer.merchantSlug}-${offer.offerId || Date.now()}` };
  }

  if (existing) {
    summary.offersUpdated += 1;
    return strapiUpdate('commerce-offers', existing.documentId, data);
  }

  summary.offersCreated += 1;
  return strapiCreate('commerce-offers', data);
}

async function createSnapshotOnce(product, merchant, offer, snapshot, sourceOffer) {
  const exists = await findSnapshotForDay(product.documentId, merchant.documentId, snapshot.checkedAt);
  if (exists) return false;

  if (dryRun) return true;

  await strapiCreate('commerce-price-snapshots', {
    product: product.documentId,
    merchant: merchant.documentId,
    offer: offer.documentId,
    price: snapshot.price,
    originalPrice: snapshot.originalPrice,
    currency: snapshot.currency,
    availability: snapshot.availability,
    checkedAt: snapshot.checkedAt,
    source: SOURCE,
    rawPayload: sourceOffer.rawPayload,
  });
  return true;
}

async function findSnapshotForDay(productDocumentId, merchantDocumentId, checkedAt) {
  if (dryRun) return null;
  const start = new Date(checkedAt);
  if (Number.isNaN(start.getTime())) return null;
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const params = new URLSearchParams({
    'pagination[pageSize]': '1',
    'filters[product][documentId][$eq]': productDocumentId,
    'filters[merchant][documentId][$eq]': merchantDocumentId,
    'filters[checkedAt][$gte]': start.toISOString(),
    'filters[checkedAt][$lt]': end.toISOString(),
  });
  const json = await strapiGet(`commerce-price-snapshots?${params.toString()}`);
  return json?.data?.[0] || null;
}

function findExistingOffer(product, merchant, sourceOffer) {
  const offers = Array.isArray(product.offers) ? product.offers : [];
  return offers.find((offer) => {
    const offerMerchant = offer.merchant || {};
    if (offerMerchant.documentId !== merchant.documentId && offerMerchant.slug !== merchant.slug) return false;
    if (sourceOffer.merchantSku && String(offer.merchantSku || '') === sourceOffer.merchantSku) return true;
    return sameHost(stringValue(offer.productUrl || offer.affiliateUrl), sourceOffer.productUrl);
  }) || null;
}

async function findOffer(productDocumentId, merchantDocumentId, sourceOffer) {
  const params = new URLSearchParams({
    'pagination[pageSize]': '25',
    'populate[0]': 'product',
    'populate[1]': 'merchant',
    'filters[merchant][documentId][$eq]': merchantDocumentId,
  });
  if (sourceOffer.merchantSku) {
    params.set('filters[merchantSku][$eq]', sourceOffer.merchantSku);
  } else {
    params.set('filters[productUrl][$eq]', sourceOffer.productUrl);
  }

  const json = await strapiGet(`commerce-offers?${params.toString()}`);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.find((offer) => offer?.product?.documentId === productDocumentId) || null;
}

function productRecordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (looksLikeProduct(payload)) return [payload];

  const rows = [];
  const containers = [payload, isRecord(payload.data) ? payload.data : undefined].filter(Boolean);
  const keys = [
    'products',
    'results',
    'items',
    'shopping_results',
    'product_results',
    'organic_results',
    'product_offers',
    'offers',
  ];

  if (Array.isArray(payload.data)) rows.push(...payload.data.filter(isRecord));
  if (isRecord(payload.data) && looksLikeProduct(payload.data)) rows.push(payload.data);
  for (const container of containers) {
    for (const key of keys) {
      if (Array.isArray(container[key])) rows.push(...container[key].filter(isRecord));
    }
  }

  return rows.filter(looksLikeProduct);
}

function offerRecordsFromProduct(product) {
  const records = [];
  for (const key of ['offer', 'best_offer', 'top_offer']) {
    if (isRecord(product[key])) records.push(product[key]);
  }
  for (const key of ['offers', 'product_offers', 'sellers', 'online_sellers', 'nearby_offers']) {
    if (Array.isArray(product[key])) records.push(...product[key].filter(isRecord));
  }
  if (!records.length && (product.offer_id || product.offer_page_url || product.price_history || product.store_name)) {
    records.push(product);
  }
  return records;
}

function looksLikeProduct(value) {
  return isRecord(value) && Boolean(
    value.product_title ||
    value.title ||
    value.name ||
    value.offer_title ||
    value.offer_page_url ||
    value.price_history ||
    value.offers ||
    value.product_offers
  );
}

function matchScore(product, offer) {
  const productText = normalizeText([
    product.name,
    product.brand,
    product.asin,
    product.gtin,
    product.mpn,
    product.sku,
  ].filter(Boolean).join(' '));
  const offerText = normalizeText([offer.title, offer.productUrl, offer.merchantSku].filter(Boolean).join(' '));
  const productTokens = significantTokens(productText);
  let score = 0;

  for (const token of productTokens) {
    if (offerText.includes(token)) score += 1;
  }

  for (const key of ['asin', 'gtin', 'mpn', 'sku']) {
    const value = normalizeText(stringValue(product[key]));
    if (value && offerText.includes(value)) score += 4;
  }

  const storage = productText.match(/\b(32gb|64gb|128gb|256gb|512gb|1tb|2tb|4gb|8gb|16gb|32gb)\b/)?.[1];
  if (storage) score += offerText.includes(storage) ? 3 : -3;

  return score;
}

async function strapiGet(pathname) {
  const response = await fetch(`${STRAPI_URL}/api/${pathname}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi GET ${pathname} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function strapiCreate(collection, data) {
  const response = await fetch(`${STRAPI_URL}/api/${collection}`, {
    method: 'POST',
    headers: strapiHeaders(),
    body: JSON.stringify({ data: prune(data) }),
  });
  if (!response.ok) throw new Error(`Strapi create ${collection} failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()).data;
}

async function strapiUpdate(collection, documentId, data) {
  const response = await fetch(`${STRAPI_URL}/api/${collection}/${documentId}`, {
    method: 'PUT',
    headers: strapiHeaders(),
    body: JSON.stringify({ data: prune(data) }),
  });
  if (!response.ok) throw new Error(`Strapi update ${collection} failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()).data;
}

async function findOne(collection, filters) {
  const params = new URLSearchParams({ 'pagination[pageSize]': '1' });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(`filters[${key}][$eq]`, value);
  }
  const json = await strapiGet(`${collection}?${params.toString()}`);
  return json?.data?.[0] || null;
}

async function rapidApiGet(pathname) {
  const response = await fetch(`https://${RAPIDAPI_HOST}${pathname}`, {
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`RapidAPI ${pathname} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function historyApiGet(pathname) {
  if (!USE_OPENWEBNINJA_HISTORY) return rapidApiGet(pathname);
  if (!OPENWEBNINJA_API_KEY) throw new Error('OPENWEBNINJA_API_KEY is required when PRICE_HISTORY_PROVIDER=openwebninja.');

  const response = await fetch(`${OPENWEBNINJA_BASE_URL}${pathname}`, {
    headers: {
      'x-api-key': OPENWEBNINJA_API_KEY,
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`OpenWeb Ninja ${pathname} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function historyApiLabel() {
  if (USE_OPENWEBNINJA_HISTORY) return `${OPENWEBNINJA_BASE_URL}${RAPIDAPI_HISTORY_PATH}`;
  return `${RAPIDAPI_HOST}${RAPIDAPI_HISTORY_PATH}`;
}

function strapiHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
  };
}

function searchQuery(product) {
  return [
    product.brand,
    product.name,
    product.asin,
    product.gtin,
    product.mpn,
    product.sku,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function merchantSlugFor(name, url) {
  const hostSlug = knownMerchantSlugFromUrl(url);
  if (hostSlug) return hostSlug;
  return slugify(name.replace(/\.(com|net|org|co\.uk)$/i, ''));
}

function knownMerchantSlugFromUrl(url) {
  const host = hostname(url);
  if (!host) return '';
  if (host.includes('amazon.')) return 'amazon';
  if (host.includes('ebay.')) return 'ebay';
  if (host.includes('walmart.')) return 'walmart';
  if (host.includes('target.')) return 'target';
  if (host.includes('bestbuy.')) return 'best-buy';
  if (host.includes('newegg.')) return 'newegg';
  return '';
}

function merchantFromUrl(url) {
  const slug = knownMerchantSlugFromUrl(url);
  if (slug) return titleCase(slug.replace(/-/g, ' '));
  const host = hostname(url);
  return host ? titleCase(host.split('.')[0].replace(/-/g, ' ')) : '';
}

function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = stringValue(value);
  if (!text) return undefined;
  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const price = Number(match[0]);
  return Number.isFinite(price) ? price : undefined;
}

function currencyFromPrice(value) {
  const text = stringValue(value);
  if (text.includes('£')) return 'GBP';
  if (text.includes('€')) return 'EUR';
  if (text.includes('CA$')) return 'CAD';
  if (text.includes('A$')) return 'AUD';
  if (text.includes('$')) return 'USD';
  return '';
}

function availabilityFromOffer(offer) {
  const text = normalizeText([
    offer.availability,
    offer.stock,
    offer.shipping,
    offer.delivery,
  ].filter(Boolean).join(' '));
  if (text.includes('out of stock') || text.includes('unavailable')) return 'out_of_stock';
  if (text.includes('preorder') || text.includes('pre order')) return 'preorder';
  if (text.includes('in stock') || text.includes('delivery') || text.includes('shipping')) return 'in_stock';
  return 'unknown';
}

function conditionFromOffer(value) {
  const text = normalizeText(stringValue(value));
  if (text.includes('refurb')) return 'refurbished';
  if (text.includes('open box')) return 'open_box';
  if (text.includes('used')) return 'used';
  if (text.includes('new')) return 'new';
  return 'unknown';
}

function dateToIso(value) {
  const text = stringValue(value);
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function dedupeSnapshots(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const day = row.checkedAt.slice(0, 10);
    const key = `${day}:${row.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function discountPercent(price, originalPrice) {
  if (!price || !originalPrice || originalPrice <= price) return undefined;
  return Number((((originalPrice - price) / originalPrice) * 100).toFixed(2));
}

function normalizeText(value) {
  return stringValue(value).toLowerCase().replace(/&quot;/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function significantTokens(value) {
  const stop = new Set(['with', 'and', 'for', 'the', 'new', 'from', 'black', 'white', 'blue', 'red']);
  return normalizeText(value).split(' ').filter((token) => token.length >= 3 && !stop.has(token)).slice(0, 20);
}

function sameHost(a, b) {
  const hostA = hostname(a);
  const hostB = hostname(b);
  return Boolean(hostA && hostB && (hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`)));
}

function hostname(value) {
  try {
    return new URL(value || '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function originFromUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function slugify(value) {
  return stringValue(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'merchant';
}

function titleCase(value) {
  return stringValue(value).replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

function bounded(value, maxLength) {
  const text = stringValue(value);
  if (!text) return undefined;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function prune(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== ''));
}

function splitList(value) {
  return stringValue(value).split(',').map((item) => slugify(item)).filter(Boolean);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeApiPath(value) {
  const text = stringValue(value);
  if (!text) return '';
  return text.startsWith('/') ? text : `/${text}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function monthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') parsed.write = true;
    else if (arg === '--dry-run') parsed.write = false;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (inlineValue !== undefined) {
        parsed[key] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i += 1;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  node scripts/fetch-product-price-history.mjs [--dry-run]
  node scripts/fetch-product-price-history.mjs --write

Options:
  --limit <n>                 Number of active products to process.
  --perProductLimit <n>       RapidAPI search result limit per product.
  --maxSnapshotsPerProduct <n> Maximum snapshots to write per product.
  --matchThreshold <n>        Minimum product/offer match score.
  --historyMonths <n>         Keep provider history snapshots from the last n months.

Environment:
  PRICE_HISTORY_REFRESH_LIMIT=25
  PRICE_HISTORY_MONTHS=6
  PRICE_HISTORY_PAGES=1
  PRICE_HISTORY_MERCHANT_SLUGS=amazon,ebay,walmart,target,best-buy,newegg
  PRICE_HISTORY_PROVIDER=rapidapi
  RAPIDAPI_PRODUCT_SEARCH_HISTORY_PATH=/product-price-history
  OPENWEBNINJA_API_KEY=       Direct OpenWeb Ninja key if PRICE_HISTORY_PROVIDER=openwebninja.
`);
}
