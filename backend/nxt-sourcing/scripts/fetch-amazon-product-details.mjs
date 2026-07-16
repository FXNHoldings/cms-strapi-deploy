#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_DIR = resolve('/opt/strapi-cms-git/backend/nxt-sourcing');
loadEnv(resolve(APP_DIR, '.env.local'));
loadEnv(resolve(APP_DIR, '.env'));

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';
const WRITE = Boolean(args.write);
const OVERWRITE = Boolean(args.overwrite);
const MISSING_ONLY = args['missing-only'] !== false;
const LIMIT = positiveInt(args.limit, 25);

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is not set in .env.local.');
if (!getAmazonDetailApiKey()) fail('Set RAPIDAPI_AMAZON_KEY, RAPIDAPI_PRODUCT_SEARCH_KEY, or RAPIDAPI_KEY in .env.local.');

const products = await loadProducts();

if (!products.length) {
  console.log('No matching Amazon products found.');
  process.exit(0);
}

let processed = 0;
let fetched = 0;
let updated = 0;
let skipped = 0;

for (const product of products) {
  processed += 1;
  const name = text(product.name) || String(product.id || 'unknown product');
  const documentId = text(product.documentId);
  const existingAsin = amazonAsinForProduct(product);
  const asin = existingAsin || await lookupAmazonAsinForProduct(product);

  if (!documentId) {
    skipped += 1;
    console.log(`- skipped ${name}: missing Strapi documentId`);
    continue;
  }

  if (!asin) {
    skipped += 1;
    console.log(`- skipped ${name}: no ASIN found`);
    continue;
  }

  if (MISSING_ONLY && !OVERWRITE && hasAmazonDetails(product)) {
    skipped += 1;
    console.log(`- skipped ${name}: Amazon details already imported`);
    continue;
  }

  try {
    const detail = await fetchAmazonProductDetail(asin);
    fetched += 1;
    const data = amazonProductUpdatePayload(product, detail, asin);

    if (!Object.keys(data).length) {
      skipped += 1;
      console.log(`- skipped ${name}: no new Amazon fields to save`);
      continue;
    }

    if (WRITE) {
      await updateProduct(documentId, data);
      updated += 1;
      console.log(`+ updated ${name} (${asin})`);
    } else {
      console.log(`\nDRY RUN: ${name} (${asin})`);
      console.log(JSON.stringify(dataPreview(data), null, 2));
    }
  } catch (error) {
    skipped += 1;
    console.error(`! failed ${name} (${asin}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(JSON.stringify({ dryRun: !WRITE, missingOnly: MISSING_ONLY, overwrite: OVERWRITE, processed, fetched, updated, skipped }, null, 2));

async function loadProducts() {
  if (args.id || args.documentId) {
    const product = await getProductByDocumentId(String(args.id || args.documentId));
    return product ? [product] : [];
  }

  if (args.slug) {
    const product = await getProductBySlug(String(args.slug));
    return product ? [product] : [];
  }

  return listAmazonProducts(LIMIT);
}

async function getProductByDocumentId(documentId) {
  const response = await fetch(`${STRAPI_URL}/api/commerce-products/${encodeURIComponent(documentId)}?${productPopulateParams()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Strapi product lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data || null;
}

async function getProductBySlug(slug) {
  const params = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
  });
  appendProductPopulateParams(params);
  const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi product slug lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data?.[0] || null;
}

async function listAmazonProducts(limit) {
  const pageSize = Math.min(Math.max(limit * 3, 25), 100);
  const products = [];
  let page = 1;

  while (products.length < limit && page <= 10) {
    const params = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': String(pageSize),
      'filters[productStatus][$eq]': 'active',
      'sort[0]': 'updatedAt:desc',
    });
    appendProductPopulateParams(params);

    const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
      headers: strapiHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Strapi product list failed: HTTP ${response.status} ${await response.text()}`);

    const json = await response.json();
    const rows = Array.isArray(json.data) ? json.data : [];
    products.push(...rows.filter(isAmazonProduct));
    if (page >= Number(json.meta?.pagination?.pageCount || 1)) break;
    page += 1;
  }

  return products.slice(0, limit);
}

function productPopulateParams() {
  const params = new URLSearchParams();
  appendProductPopulateParams(params);
  return params.toString();
}

function appendProductPopulateParams(params) {
  params.set('populate[offers][populate][merchant]', 'true');
}

async function updateProduct(documentId, data) {
  const response = await fetch(`${STRAPI_URL}/api/commerce-products/${encodeURIComponent(documentId)}`, {
    method: 'PUT',
    headers: strapiHeaders(),
    body: JSON.stringify({ data: prune(data) }),
  });
  if (!response.ok) throw new Error(`Strapi product update failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function fetchAmazonProductDetail(asin) {
  const key = getAmazonDetailApiKey();
  const provider = amazonDetailProvider();
  const host = process.env.RAPIDAPI_AMAZON_HOST || defaultAmazonHost(provider);
  const path = normalizeApiPath(process.env.RAPIDAPI_AMAZON_DETAILS_PATH || defaultAmazonDetailsPath(provider));
  const params = provider === 'amazon-asin' || provider === 'amazon-product-info2'
    ? new URLSearchParams({ asin })
    : new URLSearchParams({
        asin,
        country: process.env.RAPIDAPI_AMAZON_COUNTRY || 'US',
      });

  const response = await fetch(`https://${host}${path}?${params.toString()}`, {
    headers: {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': host,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(positiveInt(process.env.RAPIDAPI_AMAZON_DETAILS_TIMEOUT_MS, 15_000)),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

  const payload = await response.json();
  const detail = amazonDetailFromPayload(payload);
  if (!detail) throw new Error('Amazon product details payload did not include a product record.');
  return detail;
}

async function lookupAmazonAsinForProduct(product) {
  const keyword = text(product.name);
  if (!keyword) return undefined;

  try {
    const products = await fetchAmazonSearchProducts(keyword);
    const match = bestAmazonSearchMatch(keyword, products);
    if (match?.asin) {
      console.log(`  found ASIN ${match.asin} from Amazon search for ${keyword}`);
      return match.asin;
    }
  } catch (error) {
    console.error(`  Amazon ASIN lookup failed for ${keyword}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return undefined;
}

async function fetchAmazonSearchProducts(keyword) {
  const key = getAmazonDetailApiKey();
  const host = process.env.RAPIDAPI_AMAZON_HOST || 'real-time-amazon-data.p.rapidapi.com';
  const path = normalizeApiPath(process.env.RAPIDAPI_AMAZON_SEARCH_PATH || '/search');
  const params = new URLSearchParams({
    query: keyword,
    country: process.env.RAPIDAPI_AMAZON_COUNTRY || 'US',
    page: '1',
  });

  const response = await fetch(`https://${host}${path}?${params.toString()}`, {
    headers: {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': host,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(positiveInt(process.env.RAPIDAPI_AMAZON_SEARCH_TIMEOUT_MS, 15_000)),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  return amazonSearchProductsFromPayload(payload);
}

function amazonSearchProductsFromPayload(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const containers = [payload, isRecord(payload.data) ? payload.data : undefined].filter(isRecord);
  const products = [];

  for (const container of containers) {
    for (const key of ['products', 'results', 'items', 'search_results']) {
      if (Array.isArray(container[key])) products.push(...container[key].filter(isRecord));
    }
  }

  return products;
}

function bestAmazonSearchMatch(keyword, products) {
  const scored = products
    .map((product) => {
      const asin = validAsin(textField(product, ['asin', 'ASIN', 'product_asin']));
      const title = textField(product, ['product_title', 'title', 'name']) || '';
      return asin ? { asin, title, score: matchScore(keyword, title) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.score > 0 ? scored[0] : undefined;
}

function matchScore(keyword, title) {
  const keywordTokens = tokenSet(keyword);
  const titleTokens = tokenSet(title);
  if (!keywordTokens.size || !titleTokens.size) return 0;

  let score = 0;
  for (const token of keywordTokens) {
    if (titleTokens.has(token)) score += token.length > 2 ? 2 : 1;
  }

  return score / keywordTokens.size;
}

function amazonProductUpdatePayload(product, detail, asin) {
  const existingSpecs = isRecord(product.specs) ? product.specs : {};
  const provider = amazonDetailProvider();
  const identifiers = amazonIdentifiersFromDetail(detail, existingSpecs, product, asin);
  const features = amazonFeatureBullets(detail);
  const importedSpecs = amazonSpecsFromDetail(detail);
  const description = amazonDescriptionFromDetail(detail, features);
  const shortDescription = amazonShortDescriptionFromDetail(detail, features);
  const productTitle = textField(detail, ['product_title', 'title', 'name']);
  const imageUrl =
    urlField(detail, ['product_photo', 'product_image', 'image', 'thumbnail', 'main_image', 'mainImage']) ||
    stringArrayField(detail, ['product_photos', 'images', 'photos'])[0];
  const data = {};

  if ((OVERWRITE || !text(product.shortDescription)) && shortDescription) {
    data.shortDescription = shortDescription;
  }

  if ((OVERWRITE || !text(product.description)) && description) {
    data.description = description;
  }

  if ((OVERWRITE || !text(product.asin)) && identifiers.asin) data.asin = identifiers.asin;
  if ((OVERWRITE || !text(product.gtin)) && (identifiers.ean || identifiers.gtin || identifiers.upc)) {
    data.gtin = identifiers.ean || identifiers.gtin || identifiers.upc;
  }
  if ((OVERWRITE || !text(product.sku)) && identifiers.sku) data.sku = identifiers.sku;

  const ratingRecord = isRecord(detail.rating) ? detail.rating : {};
  const rating = numberField(detail, ['product_star_rating', 'stars', 'rating']) || numberField(ratingRecord, ['rate', 'rating']);
  const ratingCount =
    numberField(detail, ['product_num_ratings', 'rating_count', 'ratings_total', 'review_count', 'reviewsCount']) ||
    numberField(ratingRecord, ['rate_count', 'rating_count', 'count']);
  if ((OVERWRITE || !Number(product.rating)) && rating !== undefined) data.rating = rating;
  if ((OVERWRITE || !Number(product.ratingCount)) && ratingCount !== undefined) data.ratingCount = Math.floor(ratingCount);

  const nextSpecs = {
    ...existingSpecs,
    ...(features.length ? { Features: features } : {}),
    ...(Object.keys(importedSpecs).length
      ? {
          technicalSpecs: {
            ...(isRecord(existingSpecs.technicalSpecs) ? existingSpecs.technicalSpecs : {}),
            ...importedSpecs,
          },
        }
      : {}),
    ...(imageUrl ? { amazonProductImageUrl: imageUrl } : {}),
    ...(isRecord(detail.price) ? { amazonPrice: sanitizeAmazonDetail(detail.price) } : {}),
    ...(typeof detail.rawPrice === 'number' ? { amazonRawPrice: detail.rawPrice } : {}),
    ...(typeof detail.in_stock === 'boolean' ? { amazonInStock: detail.in_stock } : {}),
    ...(typeof detail.inStock === 'boolean' ? { amazonInStock: detail.inStock } : {}),
    amazonProductDetails: sanitizeAmazonDetail(detail),
    amazonProductDetailsImportedAt: new Date().toISOString(),
    amazonProductDetailsSource: provider,
    amazonDetailEnrichment: {
      source: 'fetch-amazon-product-details.mjs',
      asin: identifiers.asin || asin,
      productTitle: productTitle || undefined,
      fields: ['shortDescription', 'description', 'specs.Features', 'specs.technicalSpecs', 'asin', 'gtin', 'sku', 'rating'],
      importedAt: new Date().toISOString(),
    },
  };

  if (JSON.stringify(nextSpecs) !== JSON.stringify(existingSpecs)) data.specs = nextSpecs;

  return data;
}

function amazonDetailFromPayload(payload) {
  if (!isRecord(payload)) return null;
  for (const key of ['body', 'data', 'product', 'product_details', 'result', 'item']) {
    const value = payload[key];
    if (isRecord(value)) return value;
  }
  return payload.asin || payload.product_title || payload.title || payload.name || payload.product_description ? payload : null;
}

function amazonAsinForProduct(product) {
  const specs = isRecord(product.specs) ? product.specs : {};
  const technicalSpecs = isRecord(specs.technicalSpecs) ? specs.technicalSpecs : {};
  for (const value of [
    product.asin,
    product.merchantSku,
    product.sku?.replace(/^amazon-/i, ''),
    specs.ASIN,
    specs.asin,
    specs.amazonAsin,
    technicalSpecs.ASIN,
    technicalSpecs.asin,
    asinFromUrl(product.productUrl),
    asinFromUrl(product.affiliateUrl),
    ...offerValues(product, ['merchantSku', 'sku', 'productUrl', 'affiliateUrl']),
  ]) {
    const asin = validAsin(typeof value === 'string' ? asinFromUrl(value) || value : undefined);
    if (asin) return asin;
  }
  return undefined;
}

function amazonIdentifiersFromDetail(detail, specs, product, fallbackAsin) {
  const productInformation = isRecord(detail.product_information) ? detail.product_information : {};
  const technicalSpecs = isRecord(specs.technicalSpecs) ? specs.technicalSpecs : {};
  const asin = firstValidAsin([
    textField(detail, ['asin', 'ASIN', 'product_asin']),
    asinFromUrl(textField(detail, ['url', 'canonicalUrl'])),
    textField(productInformation, ['ASIN', 'asin']),
    technicalSpecs.ASIN,
    product.asin,
    fallbackAsin,
  ]);
  const ean = firstText([
    textField(detail, ['ean', 'EAN']),
    textField(productInformation, ['EAN', 'ean']),
    textField(productInformation, ['UPC', 'upc']),
    technicalSpecs.EAN,
    technicalSpecs.UPC,
    product.gtin,
  ]);
  const sku = firstText([
    textField(detail, ['sku', 'SKU', 'product_sku', 'seller_sku']),
    textField(productInformation, ['SKU', 'sku']),
    product.sku,
    asin ? `amazon-${asin}` : undefined,
  ]);
  return {
    asin,
    ean: cleanIdentifier(ean, 14),
    gtin: cleanIdentifier(ean, 14),
    upc: cleanIdentifier(ean, 14),
    sku: cleanIdentifier(sku, 100),
  };
}

function amazonFeatureBullets(detail) {
  return cleanStringArray([
    ...stringArrayField(detail, ['about_product', 'features', 'feature_bullets', 'highlights', 'featureBullets', 'aboutThisItem']),
    ...stringArrayField(isRecord(detail.product_information) ? detail.product_information : {}, ['features', 'Features']),
  ]).slice(0, 20);
}

function amazonSpecsFromDetail(detail) {
  const specs = {};
  const records = [
    detail.product_information,
    detail.product_details,
    detail.specifications,
    detail.details,
    detail.technical_details,
    detail.additional_information,
  ].filter(isRecord);

  for (const record of records) {
    flattenSpecRecord(record, specs);
  }

  for (const [target, keys] of Object.entries({
    ASIN: ['asin', 'ASIN', 'product_asin'],
    Brand: ['brand', 'product_brand'],
    Title: ['product_title', 'title', 'name'],
    Category: ['product_category', 'category'],
    EAN: ['ean', 'EAN', 'gtin', 'GTIN', 'upc', 'UPC'],
    SKU: ['sku', 'SKU', 'product_sku'],
    Marketplace: ['marketplaceId', 'marketplace_id'],
    MaxOrder: ['max_order', 'maximumQuantity'],
    AmazonUrl: ['url', 'canonicalUrl', 'product_url'],
    Stock: ['stockDetail'],
    Seller: ['seller', 'sellerName'],
  })) {
    const value = textField(detail, keys);
    if (value && !specs[target]) specs[target] = value;
  }

  return specs;
}

function flattenSpecRecord(record, output, prefix = '') {
  for (const [key, value] of Object.entries(record)) {
    const cleanKey = cleanSpecKey(prefix ? `${prefix} ${key}` : key);
    if (!cleanKey || ['product photos', 'images', 'photos'].includes(cleanKey.toLowerCase())) continue;

    if (isRecord(value)) {
      flattenSpecRecord(value, output, cleanKey);
      continue;
    }

    const cleanValue = cleanSpecValue(value);
    if (cleanValue !== undefined && output[cleanKey] === undefined) output[cleanKey] = cleanValue;
  }
}

function amazonDescriptionFromDetail(detail, features) {
  const direct = cleanLongText(
    textField(detail, ['product_description', 'description', 'Product Description', 'product_details', 'overview', 'productDescription']),
    8000,
  );
  if (direct) return direct;
  if (!features.length) return undefined;
  return features.map((feature) => `- ${feature}`).join('\n');
}

function amazonShortDescriptionFromDetail(detail, features) {
  const direct = cleanLongText(textField(detail, ['product_title', 'title', 'name', 'product_description', 'description']), 360);
  if (direct) return direct;
  return features.length ? cleanLongText(features.slice(0, 2).join(' '), 360) : undefined;
}

function isAmazonProduct(product) {
  if (amazonAsinForProduct(product)) return true;
  const haystack = normalizeForSearch([
    product.name,
    product.sku,
    product.asin,
    product.productUrl,
    product.affiliateUrl,
    product.source,
    isRecord(product.specs) ? product.specs.source : undefined,
    isRecord(product.specs) ? product.specs.specSourceMerchantSlug : undefined,
    ...offerValues(product, ['merchantSlug', 'merchantName', 'productUrl', 'affiliateUrl', 'source']),
  ].filter(Boolean).join(' '));
  return haystack.includes('amazon');
}

function hasAmazonDetails(product) {
  const specs = isRecord(product.specs) ? product.specs : {};
  return isRecord(specs.amazonProductDetails) || Boolean(specs.amazonProductDetailsImportedAt);
}

function offerValues(product, keys) {
  const offers = Array.isArray(product.offers) ? product.offers : [];
  const values = [];
  for (const offer of offers) {
    if (!isRecord(offer)) continue;
    for (const key of keys) {
      values.push(offer[key]);
    }
    if (isRecord(offer.merchant)) {
      values.push(offer.merchant.slug, offer.merchant.name);
    }
  }
  return values.filter(Boolean);
}

function dataPreview(data) {
  const preview = { ...data };
  if (preview.description) preview.description = cleanLongText(preview.description, 500);
  if (isRecord(preview.specs)) {
    preview.specs = {
      ...preview.specs,
      amazonProductDetails: '[saved raw Amazon detail snapshot]',
    };
  }
  return preview;
}

function strapiHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
  };
}

function getAmazonDetailApiKey() {
  return process.env.RAPIDAPI_AMAZON_KEY || process.env.RAPIDAPI_PRODUCT_SEARCH_KEY || process.env.RAPIDAPI_KEY || '';
}

function amazonDetailProvider() {
  const configured = String(process.env.RAPIDAPI_AMAZON_PROVIDER || '').trim().toLowerCase();
  if (configured === 'amazon-asin') return 'amazon-asin';
  if (configured === 'amazon-product-info2') return 'amazon-product-info2';

  const host = String(process.env.RAPIDAPI_AMAZON_HOST || '').toLowerCase();
  if (host.includes('amazon-asin')) return 'amazon-asin';
  if (host.includes('amazon-product-info2')) return 'amazon-product-info2';

  return 'real-time-amazon-data';
}

function defaultAmazonHost(provider) {
  if (provider === 'amazon-asin') return 'amazon-asin.p.rapidapi.com';
  if (provider === 'amazon-product-info2') return 'amazon-product-info2.p.rapidapi.com';
  return 'real-time-amazon-data.p.rapidapi.com';
}

function defaultAmazonDetailsPath(provider) {
  if (provider === 'amazon-asin') return '/asin.php';
  if (provider === 'amazon-product-info2') return '/Amazon/details_asin';
  return '/product-details';
}

function normalizeApiPath(value) {
  const path = String(value || '').trim() || '/product-details';
  return path.startsWith('/') ? path : `/${path}`;
}

function validAsin(value) {
  const candidate = value?.trim().toUpperCase();
  return candidate && /^[A-Z0-9]{10}$/.test(candidate) ? candidate : undefined;
}

function firstValidAsin(values) {
  for (const value of values) {
    const asin = validAsin(typeof value === 'string' ? value : undefined);
    if (asin) return asin;
  }
  return undefined;
}

function asinFromUrl(value) {
  if (!value) return undefined;
  return String(value).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase();
}

function textField(record, keys) {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function urlField(record, keys) {
  const value = textField(record, keys);
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

function numberField(record, keys) {
  const value = textField(record, keys);
  if (!value) return undefined;
  const number = Number(value.replace(/,/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

function stringArrayField(record, keys) {
  if (!isRecord(record)) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return cleanStringArray(value);
    if (typeof value === 'string' && value.trim()) return cleanStringArray(value.split(/\r?\n|[;•]/));
  }
  return [];
}

function cleanStringArray(values) {
  return Array.from(new Set(values.map((value) => cleanLongText(String(value).replace(/^[-*]\s*/, ''), 260)).filter(Boolean)));
}

function cleanSpecKey(value) {
  const key = String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return key ? key.slice(0, 100) : undefined;
}

function cleanSpecValue(value) {
  if (value == null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = cleanStringArray(value).slice(0, 50);
    return items.length ? items : undefined;
  }
  const cleaned = cleanLongText(String(value), 1000);
  return cleaned || undefined;
}

function cleanIdentifier(value, maxLength) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9_-]/g, '').trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function cleanLongText(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function sanitizeAmazonDetail(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return cleanLongText(value, 2000) || '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((entry) => sanitizeAmazonDetail(entry, depth + 1));
  if (!isRecord(value) || depth >= 6) return undefined;

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 180)
      .map(([key, nested]) => [key, sanitizeAmazonDetail(nested, depth + 1)])
      .filter(([, nested]) => nested !== undefined && nested !== ''),
  );
}

function prune(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== ''));
}

function firstText(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeForSearch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSet(value) {
  return new Set(
    normalizeForSearch(value)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--write') parsed.write = true;
    else if (arg === '--overwrite') parsed.overwrite = true;
    else if (arg === '--no-missing-only') parsed['missing-only'] = false;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) parsed[key] = true;
      else {
        parsed[key] = next;
        i += 1;
      }
    }
  }
  return parsed;
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) return;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  });
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`
Fetch and save Amazon product details for Strapi Commerce products.

Usage:
  node scripts/fetch-amazon-product-details.mjs --slug product-slug
  node scripts/fetch-amazon-product-details.mjs --id product-document-id
  node scripts/fetch-amazon-product-details.mjs --limit 25

Options:
  --slug <slug>          Fetch one product by slug.
  --id <documentId>      Fetch one product by Strapi documentId.
  --limit <number>       Process recent active Amazon products. Default: 25.
  --no-missing-only      Process products even if Amazon details were already saved.
  --overwrite            Replace existing description/identifier/rating fields.
  --write                Save changes to Strapi. Without this, the script is dry-run only.
  --help                 Show this help.

Environment:
  Reads ${APP_DIR}/.env.local and ${APP_DIR}/.env.
  Requires STRAPI_API_TOKEN.
  Uses RAPIDAPI_AMAZON_KEY, RAPIDAPI_PRODUCT_SEARCH_KEY, or RAPIDAPI_KEY.
  Uses RAPIDAPI_AMAZON_HOST and RAPIDAPI_AMAZON_DETAILS_PATH when set.
  Set RAPIDAPI_AMAZON_PROVIDER=amazon-asin for https://rapidapi.com/alexanderxbx/api/amazon-asin.
  Set RAPIDAPI_AMAZON_PROVIDER=amazon-product-info2 for https://rapidapi.com/mahmudulhasandev/api/amazon-product-info2.
`);
}
