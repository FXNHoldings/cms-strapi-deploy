#!/usr/bin/env node
/**
 * Create BLS Product Brand entries from existing BLS Product `brand` strings
 * and connect each product to its CMS-managed `brandRef` relation.
 *
 * Required env:
 *   STRAPI_TOKEN  Strapi API token with write access
 *
 * Optional env:
 *   STRAPI_URL    default: http://127.0.0.1:8888
 *   DRY_RUN=1     print changes without writing
 *
 * Usage:
 *   STRAPI_TOKEN=... node scripts/sync-bls-product-brands.mjs
 */

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!STRAPI_TOKEN && !DRY_RUN) {
  console.error('ERROR: STRAPI_TOKEN env var required (or set DRY_RUN=1)');
  process.exit(1);
}

async function strapi(path, init = {}) {
  const res = await fetch(`${STRAPI_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Strapi ${init.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

function normalizeBrand(rawBrand, productName) {
  const brand = String(rawBrand || '').trim();
  const name = String(productName || '');

  if (/^the$/i.test(brand) && /^the ordinary\b/i.test(name)) return 'The Ordinary';
  if (/^la roche$/i.test(brand) && /la roche[-\s]?posay/i.test(name)) return 'La Roche-Posay';
  if (/^bundle$/i.test(brand) && /la roche[-\s]?posay/i.test(name)) return 'La Roche-Posay';
  if (/^cerave$/i.test(brand)) return 'CeraVe';

  return brand;
}

async function listProducts() {
  const all = [];
  let page = 1;
  for (;;) {
    const res = await strapi(
      `/api/bls-products?fields[0]=brand&fields[1]=name&fields[2]=slug&populate[brandRef][fields][0]=slug&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    all.push(...(res.data || []));
    const pageCount = res.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page += 1;
  }
  return all;
}

async function findBrand(slug) {
  const res = await strapi(
    `/api/bls-product-brands?filters[slug][$eqi]=${encodeURIComponent(slug)}&pagination[pageSize]=1`,
  );
  return res.data?.[0] ?? null;
}

async function createBrand(name, slug) {
  if (DRY_RUN) return { documentId: `dry-${slug}`, id: `dry-${slug}`, name, slug };
  const res = await strapi('/api/bls-product-brands', {
    method: 'POST',
    body: JSON.stringify({ data: { name, slug } }),
  });
  return res.data;
}

async function updateProductBrand(product, brand) {
  if (DRY_RUN) return;
  await strapi(`/api/bls-products/${product.documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { brandRef: brand.documentId || brand.id } }),
  });
}

const products = await listProducts();
const brandCache = new Map();
let created = 0;
let linked = 0;
let skipped = 0;

for (const product of products) {
  const name = normalizeBrand(product.brand, product.name);
  if (!name) {
    skipped += 1;
    continue;
  }

  const slug = slugify(name);
  if (!slug) {
    skipped += 1;
    continue;
  }

  let brand = brandCache.get(slug);
  if (!brand) {
    brand = await findBrand(slug);
    if (!brand) {
      brand = await createBrand(name, slug);
      created += 1;
      console.log(`${DRY_RUN ? '[dry] would create' : 'created'} brand: ${name} (${slug})`);
    }
    brandCache.set(slug, brand);
  }

  if (product.brandRef?.slug === slug) {
    skipped += 1;
    continue;
  }

  await updateProductBrand(product, brand);
  linked += 1;
  console.log(`${DRY_RUN ? '[dry] would link' : 'linked'} product: ${product.name} -> ${name}`);
}

console.log(`Done. Brands created: ${created}. Products linked: ${linked}. Skipped: ${skipped}.`);
