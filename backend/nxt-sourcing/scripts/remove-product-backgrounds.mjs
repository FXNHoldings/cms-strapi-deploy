#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
loadEnv(path.join(ROOT, '.env.local'));
loadEnv(path.join(ROOT, '.env'));
loadEnv('/opt/fxn-cms-git/backend/strapi-deploy/.env');

const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;
const FAL_KEY = process.env.FAL_KEY || process.env.FAL_API_KEY;
const FAL_MODEL = process.env.FAL_BACKGROUND_REMOVAL_MODEL || 'fal-ai/imageutils/rembg';

const args = new Set(process.argv.slice(2));
const queryArg = process.argv.find((arg) => arg.startsWith('--query='));
const query = queryArg ? queryArg.slice('--query='.length).trim() : 'iphone 16';
const dryRun = args.has('--dry-run');
const force = args.has('--force');

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is required.');
if (!FAL_KEY) fail('FAL_KEY is required.');
if (!query) fail('Use --query=... to choose products.');

const products = await findProducts(query);
console.log(`Found ${products.length} product(s) matching "${query}".`);

let updated = 0;
let skipped = 0;
let failed = 0;

for (const product of products) {
  const name = product.name || product.slug || product.documentId;
  const specs = isRecord(product.specs) ? product.specs : {};
  if (!force && specs.imageBackgroundRemoved) {
    skipped += 1;
    console.log(`Skipped already-processed product: ${name}`);
    continue;
  }

  const sourceImageUrl = productImageSource(product);
  if (!sourceImageUrl) {
    skipped += 1;
    console.log(`Skipped product with no source image: ${name}`);
    continue;
  }

  try {
    console.log(`${dryRun ? 'Would process' : 'Processing'}: ${name}`);
    if (dryRun) {
      updated += 1;
      continue;
    }

    const falImage = await removeBackground(sourceImageUrl);
    const uploaded = await uploadImage(falImage.url, `commerce-product-${slugify(product.slug || product.name)}-no-bg`, falImage.content_type);
    const imageUrl = uploaded?.url ? absoluteStrapiUrl(uploaded.url) : falImage.url;

    await updateProduct(product.documentId, {
      ...(uploaded?.id ? { primaryImage: uploaded.id } : {}),
      specs: {
        ...specs,
        imageUrl,
        sourceImageUrl,
        imageBackgroundRemoved: true,
        imageBackgroundProvider: FAL_MODEL,
        imageBackgroundStorage: uploaded?.id ? 'strapi-media' : 'fal-url',
        imageBackgroundRemovedAt: new Date().toISOString(),
      },
    });

    updated += 1;
    console.log(`Updated: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`Failed: ${name} - ${error.message || error}`);
  }
}

console.log(`Done. Updated: ${updated}. Skipped: ${skipped}. Failed: ${failed}.`);
if (failed > 0) process.exitCode = 1;

async function findProducts(search) {
  const rows = [];
  let page = 1;
  let pageCount = 1;

  do {
    const params = new URLSearchParams({
      'filters[name][$containsi]': search,
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'populate[primaryImage]': 'true',
    });
    const response = await strapiFetch(`/api/commerce-products?${params.toString()}`);
    rows.push(...(Array.isArray(response?.data) ? response.data : []));
    pageCount = response?.meta?.pagination?.pageCount || 1;
    page += 1;
  } while (page <= pageCount);

  return rows;
}

async function removeBackground(imageUrl) {
  const response = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_url: imageUrl,
      sync_mode: false,
      crop_to_bbox: false,
    }),
  });

  if (!response.ok) throw new Error(`fal.ai HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  const data = await response.json();
  if (!data?.image?.url) throw new Error('fal.ai returned no image URL');
  return data.image;
}

async function uploadImage(imageUrl, filenameBase, preferredMime) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`image download HTTP ${response.status}`);

  const mime = preferredMime || response.headers.get('content-type') || 'image/png';
  if (!mime.startsWith('image/')) throw new Error(`not an image: ${mime}`);

  const extension = mime.includes('webp') ? 'webp' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
  const blob = new Blob([await response.arrayBuffer()], { type: mime });
  const form = new FormData();
  form.append('files', blob, `${filenameBase}.${extension}`);

  const responseUpload = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    body: form,
  });

  if (!responseUpload.ok) {
    console.warn(`Upload failed; keeping fal.ai URL instead. HTTP ${responseUpload.status}`);
    return null;
  }

  const json = await responseUpload.json();
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

function productImageSource(product) {
  const primary = product.primaryImage?.url ? absoluteStrapiUrl(product.primaryImage.url) : undefined;
  const specs = isRecord(product.specs) ? product.specs : {};
  const fromSpecs = [specs.sourceImageUrl, specs.imageUrl].find((value) => typeof value === 'string' && isHttpUrl(value));
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

function prune(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== ''));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
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
  console.error(message);
  process.exit(1);
}
