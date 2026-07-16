#!/usr/bin/env node
/**
 * Detect commerce product images whose border background is not white, search
 * merchant catalogs for a white-background packshot, then upload and replace
 * the Strapi primaryImage.
 *
 * Usage:
 *   node scripts/replace-nonwhite-product-images.mjs --slug=ring-battery-doorbell-plus-2nd-gen-wireless-video-doorbell-camera --write
 *   node scripts/replace-nonwhite-product-images.mjs --category="Video Doorbells" --limit=10 --write
 *   node scripts/replace-nonwhite-product-images.mjs --all --limit=25 --dry-run
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCORE_SCRIPT = path.join(ROOT, 'scripts/lib/score-image-white-background.py');
const SOURCING_API_BASE = (process.env.SOURCING_API_BASE || 'http://127.0.0.1:3005').replace(/\/$/, '');

loadEnv(path.join(ROOT, '.env.local'));
loadEnv(path.join(ROOT, '.env'));
loadEnv('/opt/fxn-cms-git/backend/strapi-deploy/.env');

const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, ...parts] = arg.slice(2).split('=');
    return [key, parts.length ? parts.join('=') : true];
  }),
);

const dryRun = args.write !== true;
const force = args.force === true;
const threshold = numberArg('threshold', 240);
const limit = numberArg('limit', 0);
const slug = stringArg('slug');
const category = stringArg('category');
const allProducts = args.all === true;
const merchants = (stringArg('merchants') || 'amazon,walmart,best-buy,newegg,target,ebay')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const perMerchantLimit = numberArg('per-merchant-limit', 5);

const MERCHANT_PRIORITY = {
  amazon: 50,
  walmart: 40,
  'best-buy': 35,
  newegg: 30,
  target: 25,
  ebay: 10,
};

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is required.');
if (!slug && !category && !allProducts) {
  fail('Provide --slug=..., --category="...", or --all.');
}

const stats = { scanned: 0, skippedWhite: 0, replaced: 0, failed: 0, noCandidate: 0 };

const products = await listProducts();
console.log(`Scanning ${products.length} product(s) for non-white feature images (threshold=${threshold}).`);

for (const product of products) {
  stats.scanned += 1;
  const label = product.name || product.slug || product.documentId;
  const currentImageUrl = productImageUrl(product);
  if (!currentImageUrl) {
    console.log(`Skip (no image): ${label}`);
    stats.failed += 1;
    continue;
  }

  const currentScore = scoreImageUrl(currentImageUrl, threshold);
  if (!currentScore) {
    console.log(`Skip (could not score current image): ${label}`);
    stats.failed += 1;
    continue;
  }

  if (currentScore.whiteBackground && !force) {
    stats.skippedWhite += 1;
    console.log(`Skip (white background): ${label}`);
    continue;
  }

  console.log(
    `${dryRun ? 'Would replace' : 'Replacing'}: ${label} | current avgRgb=${currentScore.avgRgb.join(',')} score=${currentScore.score}`,
  );

  const replacement = await findWhiteBackgroundImage(product);
  if (!replacement) {
    stats.noCandidate += 1;
    console.log(`  No white-background candidate found for: ${label}`);
    continue;
  }

  console.log(
    `  Candidate: ${replacement.merchantSlug} score=${replacement.score.score} ${replacement.imageUrl}`,
  );

  if (dryRun) {
    stats.replaced += 1;
    continue;
  }

  try {
    const uploaded = await uploadImage(
      replacement.imageUrl,
      `commerce-product-${slugify(product.slug || product.name)}-white-bg`,
    );
    if (!uploaded?.id) throw new Error('Strapi upload returned no media id');

    const specs = isRecord(product.specs) ? product.specs : {};
    const imageUrl = uploaded.url ? absoluteStrapiUrl(uploaded.url) : replacement.imageUrl;

    await updateProduct(product.documentId, {
      primaryImage: uploaded.id,
      specs: {
        ...specs,
        imageUrl,
        sourceImageUrl: replacement.imageUrl,
        primaryImageImported: true,
        imageSource: `${replacement.merchantSlug}-white-bg-search`,
        imageImportedAt: new Date().toISOString(),
        imageWhiteBackground: true,
        imageWhiteBackgroundScore: replacement.score.score,
        imageWhiteBackgroundReplacedAt: new Date().toISOString(),
        imageWhiteBackgroundMerchant: replacement.merchantSlug,
        imageWhiteBackgroundSearchQuery: replacement.searchQuery,
      },
    });

    stats.replaced += 1;
    console.log(`  Updated: ${label}`);
  } catch (error) {
    stats.failed += 1;
    console.error(`  Failed: ${label} - ${error.message || error}`);
  }
}

console.log(
  `Done. Scanned=${stats.scanned} whiteSkipped=${stats.skippedWhite} replaced=${stats.replaced} noCandidate=${stats.noCandidate} failed=${stats.failed}`,
);
if (stats.failed > 0) process.exitCode = 1;

async function listProducts() {
  const rows = [];
  let page = 1;
  let pageCount = 1;

  do {
    const params = new URLSearchParams({
      'filters[productStatus][$eq]': 'active',
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'populate[primaryImage]': 'true',
      'populate[categories][fields][0]': 'name',
      'sort[0]': 'updatedAt:desc',
    });

    if (slug) params.set('filters[slug][$eq]', slug);
    if (category) params.set('filters[categories][name][$eqi]', category);

    const response = await strapiFetch(`/api/commerce-products?${params.toString()}`);
    rows.push(...(Array.isArray(response?.data) ? response.data : []));
    pageCount = response?.meta?.pagination?.pageCount || 1;
    page += 1;
  } while (page <= pageCount);

  return limit > 0 ? rows.slice(0, limit) : rows;
}

async function findWhiteBackgroundImage(product) {
  const queries = buildSearchQueries(product);
  const seen = new Set();
  const candidates = [];

  for (const searchQuery of queries) {
    const results = await searchMerchants(searchQuery);
    for (const item of results) {
      const rawUrl = normalizeCandidateImageUrl(item.imageUrl);
      if (!rawUrl || seen.has(rawUrl)) continue;
      seen.add(rawUrl);

      const score = scoreImageUrl(rawUrl, threshold);
      if (!score?.whiteBackground) continue;

      candidates.push({
        searchQuery,
        merchantSlug: item.merchantSlug || item.merchantName || 'unknown',
        productName: item.productName || '',
        imageUrl: rawUrl,
        score,
        rank:
          (score.score || 0)
          + (MERCHANT_PRIORITY[item.merchantSlug] || 0)
          + Math.min(score.width || 0, score.height || 0) / 100,
      });
    }
  }

  return candidates.sort((left, right) => right.rank - left.rank)[0] || null;
}

async function searchMerchants(keyword) {
  const response = await fetch(`${SOURCING_API_BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keyword,
      merchants,
      filters: {
        productType: 'all',
        excludeAccessories: true,
        perMerchantLimit,
        sortBy: 'relevance',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Search API HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.results) ? payload.results : [];
}

function buildSearchQueries(product) {
  const specs = isRecord(product.specs) ? product.specs : {};
  const brand = text(specs?.technicalSpecs?.Brand || specs?.Brand || product.brand);
  const model = text(specs?.technicalSpecs?.Model);
  const name = text(product.name);
  const cleanedName = name
    .replace(/\b(open[- ]box|renewed|refurbished|new)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const queries = [];
  if (brand && model) queries.push(`${brand} ${model}`);
  if (cleanedName) queries.push(cleanedName);
  if (brand && cleanedName && !cleanedName.toLowerCase().startsWith(brand.toLowerCase())) {
    queries.push(`${brand} ${cleanedName}`);
  }

  return [...new Set(queries.filter(Boolean))];
}

function normalizeCandidateImageUrl(url) {
  const raw = String(url || '').trim();
  if (!isHttpUrl(raw)) return null;

  if (raw.includes('media-amazon.com/images/')) {
    return raw.replace(/_AC_[A-Z0-9_]+\./, '_AC_SL1500.');
  }

  if (raw.includes('i.ebayimg.com') && raw.includes('/s-l')) {
    return raw.replace('/s-l225.', '/s-l1600.').replace('/s-l300.', '/s-l1600.').replace('/s-l500.', '/s-l1600.');
  }

  return raw;
}

function scoreImageUrl(url, whiteThreshold) {
  const result = spawnSync('python3', [SCORE_SCRIPT, '--url', url, '--threshold', String(whiteThreshold)], {
    encoding: 'utf8',
  });

  if (result.status !== 0) return null;

  try {
    const payload = JSON.parse(result.stdout.trim());
    return payload.error ? null : payload;
  } catch {
    return null;
  }
}

async function uploadImage(imageUrl, filenameBase) {
  const response = await fetch(imageUrl, {
    headers: { 'User-Agent': 'NXT-Sourcing-Image-Importer/1.0' },
  });
  if (!response.ok) throw new Error(`image download HTTP ${response.status}`);

  const mime = response.headers.get('content-type') || 'image/jpeg';
  if (!mime.startsWith('image/')) throw new Error(`not an image: ${mime}`);

  const extension = mime.includes('webp') ? 'webp' : mime.includes('png') ? 'png' : 'jpg';
  const blob = new Blob([await response.arrayBuffer()], { type: mime });
  const form = new FormData();
  form.append('files', blob, `${filenameBase}.${extension}`);

  const uploadResponse = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    body: form,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Strapi upload HTTP ${uploadResponse.status}: ${await uploadResponse.text().catch(() => '')}`);
  }

  const json = await uploadResponse.json();
  return Array.isArray(json) ? json[0] || null : json;
}

async function updateProduct(documentId, data) {
  await strapiFetch(`/api/commerce-products/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: prune(data) }),
  });
}

async function strapiFetch(pathname, init = {}) {
  const response = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Strapi HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  return response.json();
}

function productImageUrl(product) {
  const primary = product.primaryImage?.url ? absoluteStrapiUrl(product.primaryImage.url) : undefined;
  const specs = isRecord(product.specs) ? product.specs : {};
  const fromSpecs = [specs.imageUrl, specs.sourceImageUrl].find((value) => typeof value === 'string' && isHttpUrl(value));
  return primary || fromSpecs;
}

function absoluteStrapiUrl(value) {
  return value.startsWith('http') ? value : `${STRAPI_URL}${value}`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function slugify(value) {
  return String(value || 'product')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'product';
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function prune(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== ''));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numberArg(key, fallback) {
  const value = Number(args[key]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function stringArg(key) {
  return typeof args[key] === 'string' ? String(args[key]).trim() : '';
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}
