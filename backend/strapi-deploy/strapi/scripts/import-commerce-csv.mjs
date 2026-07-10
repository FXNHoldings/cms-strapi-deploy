/* eslint-disable no-console */
'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');
const { parse } = require('csv-parse/sync');

process.on('uncaughtException', (error) => {
  if (error?.message === 'aborted') process.exit(0);
  throw error;
});

const MERCHANT_DEFAULTS = {
  amazon: { name: 'Amazon', websiteUrl: 'https://www.amazon.com', country: 'US', affiliateNetwork: 'Amazon Associates' },
  walmart: { name: 'Walmart', websiteUrl: 'https://www.walmart.com', country: 'US', affiliateNetwork: 'Walmart Creator / Impact' },
  ebay: { name: 'eBay', websiteUrl: 'https://www.ebay.com', country: 'US', affiliateNetwork: 'eBay Partner Network' },
  target: { name: 'Target', websiteUrl: 'https://www.target.com', country: 'US', affiliateNetwork: 'Target Partners' },
  'best-buy': { name: 'Best Buy', websiteUrl: 'https://www.bestbuy.com', country: 'US', affiliateNetwork: 'Best Buy Affiliate Program' },
  sephora: { name: 'Sephora', websiteUrl: 'https://www.sephora.com', country: 'US', affiliateNetwork: 'Sephora Affiliate Program' },
  ulta: { name: 'Ulta Beauty', websiteUrl: 'https://www.ulta.com', country: 'US', affiliateNetwork: 'Ulta Affiliate Program' },
  currys: { name: 'Currys', websiteUrl: 'https://www.currys.co.uk', country: 'GB', affiliateNetwork: 'Awin / affiliate network' },
  argos: { name: 'Argos', websiteUrl: 'https://www.argos.co.uk', country: 'GB', affiliateNetwork: 'Awin / affiliate network' },
  aliexpress: { name: 'AliExpress', websiteUrl: 'https://www.aliexpress.com', country: 'CN', affiliateNetwork: 'AliExpress Portals / affiliate network' },
};

function args() {
  const out = { dryRun: false, snapshotAlways: false };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--snapshot-always') out.snapshotAlways = true;
    else if (arg === '--file') out.file = process.argv[++i];
    else if (arg.startsWith('--file=')) out.file = arg.slice('--file='.length);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function help() {
  console.log(`Usage:
  npm run commerce:import -- --file ./imports/products.csv
  npm run commerce:import -- --file ./imports/products.csv --dry-run
  npm run commerce:import -- --file ./imports/products.csv --snapshot-always

Required CSV columns:
  merchantSlug,productName,productUrl,price

Recommended CSV columns:
  merchantSlug,merchantName,merchantWebsite,country,affiliateNetwork,productName,productSlug,brand,category,productUrl,affiliateUrl,price,originalPrice,currency,availability,condition,asin,gtin,mpn,sku,merchantSku,imageUrl,description,shortDescription,keyFeatures,tags,rating,ratingCount,checkedAt,couponCode,shippingCost,source,active
`);
}

function clean(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function number(value) {
  const text = clean(value);
  if (!text) return undefined;
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function bool(value) {
  const text = clean(value)?.toLowerCase();
  if (!text) return undefined;
  if (['1', 'true', 'yes', 'y', 'in_stock', 'active'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'out_of_stock', 'expired'].includes(text)) return false;
  return undefined;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function availability(value) {
  const text = clean(value)?.toLowerCase();
  if (!text) return 'unknown';
  if (['in_stock', 'instock', 'in stock', 'available', 'true', 'yes', '1'].includes(text)) return 'in_stock';
  if (['out_of_stock', 'out of stock', 'unavailable', 'sold out', 'false', 'no', '0'].includes(text)) return 'out_of_stock';
  if (['preorder', 'pre-order', 'pre order'].includes(text)) return 'preorder';
  return 'unknown';
}

function condition(value) {
  const text = clean(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (['new', 'used', 'refurbished', 'open_box'].includes(text)) return text;
  return 'unknown';
}

function discountPercent(price, originalPrice) {
  if (!price || !originalPrice || originalPrice <= price) return undefined;
  return Math.round((1 - price / originalPrice) * 10000) / 100;
}

async function findOne(strapi, uid, filters, populate) {
  const rows = await strapi.documents(uid).findMany({
    status: 'published',
    filters,
    populate,
    pagination: { pageSize: 1 },
  });
  return rows[0] ?? null;
}

async function ensureMerchant(strapi, row, dryRun) {
  const slug = slugify(clean(row.merchantSlug) || clean(row.merchantName));
  if (!slug) throw new Error('Missing merchantSlug');

  const existing = await findOne(strapi, 'api::commerce-merchant.commerce-merchant', { slug: { $eq: slug } });
  if (existing) return { item: existing, created: false };

  const defaults = MERCHANT_DEFAULTS[slug] ?? {};
  const data = {
    name: clean(row.merchantName) || defaults.name || slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    slug,
    websiteUrl: clean(row.merchantWebsite) || defaults.websiteUrl,
    country: clean(row.country) || defaults.country,
    affiliateNetwork: clean(row.affiliateNetwork) || defaults.affiliateNetwork,
    status: 'active',
    trackingParams: { source: 'commerce-csv-import' },
  };

  if (dryRun) return { item: { documentId: `dry-merchant-${slug}`, id: -1, ...data }, created: true };
  const item = await strapi.documents('api::commerce-merchant.commerce-merchant').create({ status: 'published', data });
  return { item, created: true };
}

async function ensureBrand(strapi, name, dryRun) {
  const brandName = clean(name);
  if (!brandName) return { item: null, created: false };

  const slug = slugify(brandName);
  const existing = await findOne(strapi, 'api::commerce-brand.commerce-brand', { slug: { $eq: slug } });
  if (existing) return { item: existing, created: false };

  const data = { name: brandName, slug, status: 'active' };
  if (dryRun) return { item: { documentId: `dry-brand-${slug}`, id: -1, ...data }, created: true };
  const item = await strapi.documents('api::commerce-brand.commerce-brand').create({ status: 'published', data });
  return { item, created: true };
}

async function ensureCategory(strapi, name, dryRun) {
  const categoryName = clean(name);
  if (!categoryName) return { item: null, created: false };

  const slug = slugify(categoryName);
  const existing = await findOne(strapi, 'api::commerce-category.commerce-category', { slug: { $eq: slug } });
  if (existing) return { item: existing, created: false };

  const data = { name: categoryName, slug, status: 'active' };
  if (dryRun) return { item: { documentId: `dry-category-${slug}`, id: -1, ...data }, created: true };
  const item = await strapi.documents('api::commerce-category.commerce-category').create({ status: 'published', data });
  return { item, created: true };
}

async function uploadImage(strapi, imageUrl, filename, dryRun) {
  const url = clean(imageUrl);
  if (!url || dryRun) return null;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image ${url}: HTTP ${response.status}`);
  const mime = response.headers.get('content-type') || 'image/jpeg';
  const extension = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const buffer = Buffer.from(await response.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `${filename}-${Date.now()}.${extension}`);
  fs.writeFileSync(tmp, buffer);

  try {
    const stats = fs.statSync(tmp);
    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: {
        fileInfo: {
          name: filename,
          alternativeText: filename.replace(/-/g, ' '),
        },
      },
      files: {
        filepath: tmp,
        originalFilename: `${filename}.${extension}`,
        mimetype: mime,
        size: stats.size,
      },
    });
    return Array.isArray(uploaded) ? uploaded[0] : uploaded;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function findProduct(strapi, row) {
  const gtin = clean(row.gtin);
  const asin = clean(row.asin);
  const mpn = clean(row.mpn);
  const sku = clean(row.sku);
  const slug = slugify(clean(row.productSlug) || clean(row.productName));

  if (gtin) {
    const item = await findOne(strapi, 'api::commerce-product.commerce-product', { gtin: { $eqi: gtin } });
    if (item) return item;
  }
  if (asin) {
    const item = await findOne(strapi, 'api::commerce-product.commerce-product', { asin: { $eqi: asin } });
    if (item) return item;
  }
  if (mpn) {
    const item = await findOne(strapi, 'api::commerce-product.commerce-product', { mpn: { $eqi: mpn } });
    if (item) return item;
  }
  if (sku) {
    const item = await findOne(strapi, 'api::commerce-product.commerce-product', { sku: { $eqi: sku } });
    if (item) return item;
  }
  if (slug) {
    const item = await findOne(strapi, 'api::commerce-product.commerce-product', { slug: { $eq: slug } });
    if (item) return item;
  }
  return null;
}

async function upsertProduct(strapi, row, brand, category, dryRun) {
  const existing = await findProduct(strapi, row);
  if (existing) return { item: existing, created: false, updated: false };

  const name = clean(row.productName);
  if (!name) throw new Error('Missing productName');

  const image = await uploadImage(strapi, row.imageUrl, `commerce-product-${slugify(name)}`, dryRun);
  const specs = {
    source: 'commerce-csv-import',
    importedAt: new Date().toISOString(),
    sourceUrl: clean(row.productUrl),
    primaryAffiliateUrl: clean(row.affiliateUrl),
    keyFeatures: clean(row.keyFeatures)?.split('|').map((x) => x.trim()).filter(Boolean) ?? [],
  };

  const data = {
    name,
    slug: slugify(clean(row.productSlug) || name),
    brand: clean(row.brand),
    brandRef: brand?.documentId,
    shortDescription: clean(row.shortDescription),
    description: clean(row.description),
    primaryImage: image?.id,
    category: clean(row.category),
    categories: category ? [category.documentId] : [],
    tags: clean(row.tags)?.split('|').map((x) => x.trim()).filter(Boolean) ?? ['commerce-csv-import'],
    specs,
    asin: clean(row.asin),
    gtin: clean(row.gtin),
    mpn: clean(row.mpn),
    sku: clean(row.sku),
    rating: number(row.rating),
    ratingCount: number(row.ratingCount),
    status: 'active',
  };

  if (dryRun) return { item: { documentId: `dry-product-${data.slug}`, id: -1, ...data }, created: true, updated: false };
  const item = await strapi.documents('api::commerce-product.commerce-product').create({ status: 'published', data });
  return { item, created: true, updated: false };
}

async function findOffer(strapi, product, merchant, row) {
  const productUrl = clean(row.productUrl);
  const affiliateUrl = clean(row.affiliateUrl);
  const merchantSku = clean(row.merchantSku) || clean(row.asin) || clean(row.sku);
  const filters = productUrl || affiliateUrl
    ? { $or: [{ productUrl: { $eq: productUrl } }, { affiliateUrl: { $eq: affiliateUrl || productUrl } }] }
    : { merchantSku: { $eq: merchantSku } };

  const candidates = await strapi.documents('api::commerce-offer.commerce-offer').findMany({
    filters,
    populate: { product: true, merchant: true },
    pagination: { pageSize: 100 },
  });
  return candidates.find((offer) =>
    offer.product?.documentId === product.documentId &&
    offer.merchant?.documentId === merchant.documentId
  ) ?? null;
}

async function upsertOffer(strapi, row, product, merchant, dryRun) {
  const productUrl = clean(row.productUrl) || clean(row.affiliateUrl);
  if (!productUrl) throw new Error('Missing productUrl or affiliateUrl');

  const price = number(row.price);
  const originalPrice = number(row.originalPrice);
  const existing = await findOffer(strapi, product, merchant, row);
  const data = {
    product: product.documentId,
    merchant: merchant.documentId,
    title: clean(row.offerTitle) || clean(row.productName),
    price,
    originalPrice,
    currency: clean(row.currency) || 'USD',
    discountPercent: number(row.discountPercent) ?? discountPercent(price, originalPrice),
    productUrl,
    affiliateUrl: clean(row.affiliateUrl),
    couponCode: clean(row.couponCode),
    availability: availability(row.availability),
    shippingCost: number(row.shippingCost),
    condition: condition(row.condition),
    merchantSku: clean(row.merchantSku) || clean(row.asin) || clean(row.sku),
    source: clean(row.source) || 'commerce-csv-import',
    lastCheckedAt: clean(row.checkedAt) || new Date().toISOString(),
    status: bool(row.active) === false ? 'expired' : 'active',
  };

  if (dryRun) return { item: { documentId: `dry-offer-${product.documentId}-${merchant.documentId}`, id: -1, ...data }, created: !existing, updated: !!existing };

  if (existing) {
    const item = await strapi.documents('api::commerce-offer.commerce-offer').update({
      documentId: existing.documentId,
      data,
    });
    return { item, created: false, updated: true };
  }

  const item = await strapi.documents('api::commerce-offer.commerce-offer').create({ data });
  return { item, created: true, updated: false };
}

async function latestSnapshot(strapi, product, merchant) {
  const rows = await strapi.documents('api::commerce-price-snapshot.commerce-price-snapshot').findMany({
    filters: {
      product: { documentId: { $eq: product.documentId } },
      merchant: { documentId: { $eq: merchant.documentId } },
    },
    sort: ['checkedAt:desc'],
    pagination: { pageSize: 1 },
  });
  return rows[0] ?? null;
}

async function maybeCreateSnapshot(strapi, row, product, merchant, offer, dryRun, snapshotAlways) {
  const price = number(row.price);
  if (price === undefined) return { created: false, skipped: true };

  const latest = await latestSnapshot(strapi, product, merchant);
  if (!snapshotAlways && latest && Number(latest.price) === price && latest.availability === availability(row.availability)) {
    return { created: false, skipped: true };
  }

  const data = {
    product: product.documentId,
    merchant: merchant.documentId,
    offer: offer.documentId,
    price,
    originalPrice: number(row.originalPrice),
    currency: clean(row.currency) || 'USD',
    availability: availability(row.availability),
    checkedAt: clean(row.checkedAt) || new Date().toISOString(),
    source: clean(row.source) || 'commerce-csv-import',
    rawPayload: row,
  };

  if (!dryRun) await strapi.documents('api::commerce-price-snapshot.commerce-price-snapshot').create({ data });
  return { created: true, skipped: false };
}

async function importRows(strapi, rows, options) {
  const stats = {
    rows: rows.length,
    merchantsCreated: 0,
    merchantsFound: 0,
    brandsCreated: 0,
    categoriesCreated: 0,
    productsCreated: 0,
    productsFound: 0,
    offersCreated: 0,
    offersUpdated: 0,
    snapshotsCreated: 0,
    snapshotsSkipped: 0,
    errors: 0,
  };

  for (const [index, row] of rows.entries()) {
    try {
      const merchant = await ensureMerchant(strapi, row, options.dryRun);
      merchant.created ? stats.merchantsCreated++ : stats.merchantsFound++;

      const brand = await ensureBrand(strapi, row.brand, options.dryRun);
      if (brand.created) stats.brandsCreated++;

      const category = await ensureCategory(strapi, row.category, options.dryRun);
      if (category.created) stats.categoriesCreated++;

      const product = await upsertProduct(strapi, row, brand.item, category.item, options.dryRun);
      product.created ? stats.productsCreated++ : stats.productsFound++;

      const offer = await upsertOffer(strapi, row, product.item, merchant.item, options.dryRun);
      if (offer.created) stats.offersCreated++;
      if (offer.updated) stats.offersUpdated++;

      const snapshot = await maybeCreateSnapshot(
        strapi,
        row,
        product.item,
        merchant.item,
        offer.item,
        options.dryRun,
        options.snapshotAlways,
      );
      snapshot.created ? stats.snapshotsCreated++ : stats.snapshotsSkipped++;
    } catch (error) {
      stats.errors++;
      console.error(`Row ${index + 2} failed: ${error.message}`);
    }
  }

  return stats;
}

async function main() {
  const options = args();
  if (options.help || !options.file) {
    help();
    process.exit(options.help ? 0 : 1);
  }

  const csv = fs.readFileSync(options.file, 'utf8');
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const strapi = await createStrapi().load();
  try {
    const stats = await importRows(strapi, rows, options);
    console.log(JSON.stringify({ dryRun: options.dryRun, snapshotAlways: options.snapshotAlways, ...stats }, null, 2));
  } finally {
    await strapi.destroy().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
