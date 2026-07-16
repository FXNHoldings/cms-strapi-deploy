#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const gsmarena = require('gsmarena-api');

const APP_DIR = resolve('/opt/strapi-cms-git/backend/nxt-sourcing');
loadEnv(resolve(APP_DIR, '.env.local'));

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';
const WRITE = Boolean(args.write);
const OVERWRITE = Boolean(args.overwrite);
const LIMIT = positiveInt(args.limit, 10);
const CATEGORY = text(args.category || args.categorySlug);
const MATCH_THRESHOLD = Number(args.matchThreshold || 7);
const REQUEST_DELAY_MS = positiveInt(args.delayMs || process.env.GSMARENA_REQUEST_DELAY_MS, 1200);
let brandCache = null;

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is not set in .env.local.');

const categoryFilter = CATEGORY ? await resolveCategoryFilter(CATEGORY) : null;
if (CATEGORY && !categoryFilter) {
  fail(`No active commerce category found for "${CATEGORY}". Use the category name or slug exactly as it appears in Strapi.`);
}

const products = await loadProducts();

if (!products.length) {
  console.log('No matching products found.');
  process.exit(0);
}

let processed = 0;
let updated = 0;
let skipped = 0;
let errors = 0;

for (const product of products) {
  processed += 1;
  const name = text(product.name);
  const documentId = text(product.documentId);

  if (!documentId) {
    console.log(`- skipped ${name || product.id}: missing documentId`);
    skipped += 1;
    continue;
  }

  if (!OVERWRITE && hasGsmarenaSpecs(product)) {
    console.log(`- skipped ${name}: GSMArena specs already imported. Use --overwrite to replace.`);
    skipped += 1;
    continue;
  }

  try {
    console.log(`[${processed}/${products.length}] ${name}`);
    const match = await findBestDeviceMatch(product);
    if (!match) {
      console.log('  no GSMArena search result matched confidently');
      skipped += 1;
      continue;
    }

    if (REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);
    const device = await gsmarena.catalog.getDevice(match.id);
    const gsmarenaSpecs = normalizeDeviceSpecs(device, match);

    if (!gsmarenaSpecs.specifications.length) {
      console.log(`  skipped ${match.name}: no detail specifications returned`);
      skipped += 1;
      continue;
    }

    const nextSpecs = {
      ...(isRecord(product.specs) ? product.specs : {}),
      gsmarena: gsmarenaSpecs,
      gsmarenaImportedAt: new Date().toISOString(),
      source: 'GSMArena',
    };

    if (WRITE) {
      await updateProduct(documentId, { specs: nextSpecs });
      updated += 1;
      console.log(`  + imported ${gsmarenaSpecs.specifications.length} spec group(s) from ${match.name}`);
    } else {
      console.log(`  DRY RUN: would import ${gsmarenaSpecs.specifications.length} spec group(s) from ${match.name}`);
      console.log(`  match score: ${match.score} | id: ${match.id}`);
      console.log(JSON.stringify(gsmarenaSpecs.specifications.slice(0, 3), null, 2));
    }
  } catch (error) {
    errors += 1;
    console.error(`  ! failed ${name}: ${friendlyError(error)}`);
  }

  if (REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);
}

console.log(JSON.stringify({
  dryRun: !WRITE,
  category: categoryFilter?.name || CATEGORY || null,
  processed,
  updated,
  skipped,
  errors,
}, null, 2));

if (!WRITE) console.log('No changes were saved. Add --write to update Strapi.');

async function loadProducts() {
  if (args.id || args.documentId) {
    const product = await getProductByDocumentId(String(args.id || args.documentId));
    return product ? [product] : [];
  }

  if (args.slug) {
    const product = await getProductBySlug(String(args.slug));
    return product ? [product] : [];
  }

  return listProducts(LIMIT, categoryFilter);
}

async function findBestDeviceMatch(product) {
  const query = searchQueryFor(product);
  if (!query) return null;

  const results = await gsmarena.search.search(query);
  const candidates = (Array.isArray(results) ? results : [])
    .map((result) => ({
      id: text(result.id),
      name: text(result.name),
      img: text(result.img),
      description: text(result.description),
      score: matchScore(product, result),
    }))
    .filter((result) => result.id && result.name)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (best && best.score >= MATCH_THRESHOLD) return best;

  return findBestBrandDeviceMatch(product);
}

async function findBestBrandDeviceMatch(product) {
  const brand = await inferBrand(product);
  if (!brand) return null;

  const devices = await gsmarena.catalog.getBrand(brand.id);
  const candidates = (Array.isArray(devices) ? devices : [])
    .map((device) => ({
      id: text(device.id),
      name: text(device.name),
      img: text(device.img),
      description: text(device.description),
      score: matchScore(product, device),
    }))
    .filter((device) => device.id && device.name)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < MATCH_THRESHOLD) return null;
  return best;
}

async function inferBrand(product) {
  const explicit = normalizeText(product.brandRef?.name || product.brand || '');
  const productName = normalizeText(product.name);
  const brands = await getBrands();

  return brands.find((brand) => explicit && normalizeText(brand.name) === explicit)
    || brands.find((brand) => productName.startsWith(`${normalizeText(brand.name)} `))
    || knownBrandFromName(productName, brands);
}

async function getBrands() {
  if (!brandCache) brandCache = await gsmarena.catalog.getBrands();
  return Array.isArray(brandCache) ? brandCache : [];
}

function knownBrandFromName(productName, brands) {
  const aliases = [
    ['iphone', 'Apple'],
    ['ipad', 'Apple'],
    ['galaxy', 'Samsung'],
    ['pixel', 'Google'],
    ['oneplus', 'OnePlus'],
    ['xiaomi', 'Xiaomi'],
    ['redmi', 'Xiaomi'],
    ['honor', 'Honor'],
    ['tcl', 'TCL'],
  ];
  const match = aliases.find(([alias]) => productName.includes(alias));
  if (!match) return null;
  return brands.find((brand) => normalizeText(brand.name) === normalizeText(match[1])) || null;
}

function searchQueryFor(product) {
  const name = text(product.name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(5g|lte|unlocked|renewed|refurbished|open box|no shipping|new)\b/gi, ' ')
    .replace(/\b\d+\s?(gb|tb)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name;
}

function normalizeDeviceSpecs(device, match) {
  const detailSpec = Array.isArray(device?.detailSpec) ? device.detailSpec : [];
  const specifications = detailSpec.map((group) => ({
    category: titleCase(text(group.category)),
    specifications: (Array.isArray(group.specifications) ? group.specifications : [])
      .map((spec) => ({
        name: titleCase(text(spec.name)),
        value: text(spec.value),
      }))
      .filter((spec) => spec.name && spec.value),
  })).filter((group) => group.category && group.specifications.length);

  return {
    source: 'GSMArena',
    deviceId: text(device?.id || match.id),
    deviceName: text(device?.name || match.name),
    image: text(device?.img || match.img),
    url: match.id ? `https://www.gsmarena.com/${match.id}.php` : '',
    quickSpec: Array.isArray(device?.quickSpec) ? device.quickSpec : [],
    specifications,
  };
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
  appendProductPopulate(params);
  const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi product slug lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data?.[0] || null;
}

async function listProducts(limit, category) {
  const params = new URLSearchParams({
    'filters[productStatus][$eq]': 'active',
    'filters[tags][$containsi]': 'nxt-bargains',
    'sort[0]': 'updatedAt:desc',
    'pagination[pageSize]': String(limit),
  });
  if (category?.slug) params.set('filters[categories][slug][$eqi]', category.slug);
  appendProductPopulate(params);

  const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi product list failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data || [];
}

async function resolveCategoryFilter(category) {
  const params = new URLSearchParams({
    'filters[$or][0][slug][$eqi]': category,
    'filters[$or][1][name][$eqi]': category,
    'filters[categoryStatus][$eq]': 'active',
    'pagination[pageSize]': '1',
  });
  const response = await fetch(`${STRAPI_URL}/api/commerce-categories?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi category lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  const categoryRow = json.data?.[0];
  return categoryRow ? { name: text(categoryRow.name), slug: text(categoryRow.slug) } : null;
}

async function updateProduct(documentId, data) {
  const response = await fetch(`${STRAPI_URL}/api/commerce-products/${encodeURIComponent(documentId)}`, {
    method: 'PUT',
    headers: strapiHeaders(),
    body: JSON.stringify({ data }),
  });
  if (!response.ok) throw new Error(`Strapi update failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function appendProductPopulate(params) {
  params.set('populate[categories]', 'true');
}

function productPopulateParams() {
  const params = new URLSearchParams();
  appendProductPopulate(params);
  return params.toString();
}

function matchScore(product, result) {
  const productName = normalizeText(product.name);
  const resultName = normalizeText(`${result.name || ''} ${result.description || ''}`);
  const displayName = normalizeText(result.name);
  const productTokens = significantTokens(searchQueryFor(product) || productName);
  const resultTokens = significantTokens(resultName);
  if (!productTokens.length || !resultTokens.length) return 0;

  let score = 0;
  for (const token of productTokens) {
    if (resultTokens.includes(token)) score += 2;
  }

  const productBrand = normalizeText(product.brandRef?.name || product.brand || '').split(' ')[0];
  if (productBrand && resultName.includes(productBrand)) score += 2;
  if (displayName === normalizeText(searchQueryFor(product))) score += 6;
  if (displayName && (productName.includes(displayName) || displayName.includes(productName))) score += 3;
  return score;
}

function significantTokens(value) {
  const stop = new Set(['with', 'and', 'for', 'the', 'new', 'plus', 'ultra']);
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !stop.has(token))
    .slice(0, 12);
}

function hasGsmarenaSpecs(product) {
  const specs = isRecord(product.specs) ? product.specs : {};
  return isRecord(specs.gsmarena) || Boolean(specs.gsmarenaImportedAt);
}

function strapiHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
  };
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
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

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') parsed.write = true;
    else if (arg === '--dry-run') parsed.write = false;
    else if (arg === '--overwrite') parsed.overwrite = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
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

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeText(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleCase(value) {
  return text(value).replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('429')) {
    return `${message}. GSMArena rate-limited the request; wait a few minutes and retry with a larger --delayMs value.`;
  }
  return message;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  node scripts/import-gsmarena-specs.mjs --category "Smart Phones" --limit 10
  node scripts/import-gsmarena-specs.mjs --category "Smart Phones" --limit 10 --write
  node scripts/import-gsmarena-specs.mjs --slug <product-slug> --write

Options:
  --category <name>        Process active products in this Strapi category name or slug.
  --limit <n>              Number of products to process. Default 10.
  --slug <slug>            Process one product by frontend slug.
  --id <documentId>        Process one product by Strapi documentId.
  --write                  Save specs into product.specs.gsmarena. Dry-run by default.
  --overwrite              Replace existing specs.gsmarena data.
  --matchThreshold <n>     Minimum GSMArena match score. Default 7.
  --delayMs <n>            Delay between requests. Default 1200.

Output:
  Saves grouped GSMArena specifications into specs.gsmarena, including Network,
  Launch, Body, Display, Platform, Memory, Camera, Sound, Comms, Battery, and Misc
  when GSMArena returns those sections.
`);
}
