#!/usr/bin/env node
/**
 * Import an iHerb category listing into commerce-products, with iHerb itself as
 * the first offer.
 *
 *   node scripts/import-iherb-category.mjs --category=hyaluronic-acid            # dry run
 *   node scripts/import-iherb-category.mjs --category=hyaluronic-acid --write
 *   node scripts/import-iherb-category.mjs --category=hyaluronic-acid --write --pages=3
 *
 * Requires ZENROWS_API_KEY and STRAPI_API_TOKEN in the environment (the sh
 * wrappers in this directory source .env.local the same way).
 *
 * Why scrape rather than use DataForSEO: DataForSEO answers a keyword or a
 * product id, and neither gives "everything iHerb files under hyaluronic acid".
 * The category listing is the only place that set exists.
 *
 * What this does NOT do is price-compare. It records exactly one offer per
 * product -- iHerb's own, at iHerb's own price, in AUD. Finding other sellers
 * is a separate, paid step (resolve-product-ids then fetch-offers-sellers), and
 * keeping them separate means a scrape failure can never silently rewrite
 * prices sourced from somewhere else.
 *
 * Idempotent: products are matched on their iHerb part number, stored in `sku`,
 * so a re-run updates rather than duplicating. The iHerb offer is matched on
 * product + merchant for the same reason.
 */
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const CATEGORY = flag('category');
const SITE = flag('site', 'bestlooking-skin');
const PAGES = Number(flag('pages', 2));
const LIMIT = Number(flag('limit', Infinity));
const BASE = flag('base', 'https://au.iherb.com/c');
const CURRENCY = flag('currency', 'AUD');

if (!CATEGORY) {
  console.error('--category=<iherb-category-slug> is required');
  process.exit(2);
}

function envFrom(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
}
const env = { ...envFrom('/opt/projects/nxt.discount/.env.local'), ...process.env };

const ZEN = process.env.ZENROWS_API_KEY || env.ZENROWS_API_KEY;
const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
if (!ZEN) { console.error('ZENROWS_API_KEY not set'); process.exit(2); }
if (!TOKEN) { console.error('STRAPI_API_TOKEN not set'); process.exit(2); }

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
  return body;
}

const unescapeHtml = (s) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const money = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, ' ')
  .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 90);

async function fetchThrough(url) {
  const params = new URLSearchParams({
    apikey: ZEN, url, js_render: 'true', premium_proxy: 'true', proxy_country: 'au',
  });
  const res = await fetch(`https://api.zenrows.com/v1/?${params}`, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    console.error(`  ZenRows ${res.status} on ${url}`);
    return null;
  }
  return res.text();
}

/* Same card reader as the flash-deals scraper: the numbers come from the
   card's own data-cart-info payload rather than from price text, so a price can
   never be paired with the wrong product when the markup shifts. */
function parseListing(html) {
  const bounds = [...html.matchAll(/class="product-inner/g)].map((m) => m.index);
  const out = [];
  for (let i = 0; i < bounds.length; i += 1) {
    const card = html.slice(bounds[i], bounds[i + 1] ?? bounds[i] + 20000);
    const ci = card.match(/data-cart-info="(.*?)"\s/s);
    if (!ci) continue;
    let item;
    try { item = JSON.parse(unescapeHtml(ci.group ? ci.group(1) : ci[1]))?.lineItems?.[0]; } catch { continue; }
    if (!item?.productId || !item.productName) continue;

    const url = card.match(/href="(https:\/\/au\.iherb\.com\/pr\/[^"]+)"/)?.[1];
    if (!url) continue;
    const rating = card.match(/title="([\d.]+)\/5 - ([\d,]+) Reviews"/);
    const listPrice = money(item.listPrice);
    const discountPrice = money(item.discountPrice);

    out.push({
      iherbId: String(item.productId),
      partNumber: item.PartNumber || null,
      name: String(item.productName).trim(),
      brand: card.match(/data-ga-brand-name="([^"]*)"/)?.[1] || null,
      image: item.iURLMedium || item.iURLSmall || null,
      url: url.split('?')[0],
      /* discountPrice is absent on undiscounted rows; then list IS the price. */
      price: discountPrice ?? listPrice,
      originalPrice: discountPrice && listPrice && listPrice > discountPrice ? listPrice : null,
      rating: rating ? Number(rating[1]) : null,
      ratingCount: rating ? Number(rating[2].replace(/,/g, '')) : null,
    });
  }
  return out;
}

/* ---------- resolve the Strapi rows we attach to ---------- */
const catRes = await api(`/api/commerce-categories?filters[slug][$eq]=${encodeURIComponent(CATEGORY)}&pagination[pageSize]=1`);
const category = catRes?.data?.[0];
if (!category) { console.error(`no commerce-category with slug "${CATEGORY}"`); process.exit(2); }

const siteRes = await api(`/api/commerce-sites?filters[slug][$eq]=${encodeURIComponent(SITE)}&pagination[pageSize]=1`);
const site = siteRes?.data?.[0];
if (!site) { console.error(`no commerce-site with slug "${SITE}"`); process.exit(2); }

const merchRes = await api('/api/commerce-merchants?filters[slug][$eq]=iherb&pagination[pageSize]=1');
const merchant = merchRes?.data?.[0];
if (!merchant) { console.error('no commerce-merchant with slug "iherb"'); process.exit(2); }

console.log(`category ${category.name} (${category.documentId})`);
console.log(`site     ${site.name} (${site.documentId})`);
console.log(`merchant ${merchant.name} (${merchant.documentId})`);

/* ---------- scrape ---------- */
const scraped = new Map();
for (let p = 1; p <= PAGES; p += 1) {
  const url = p === 1 ? `${BASE}/${CATEGORY}` : `${BASE}/${CATEGORY}?p=${p}`;
  const html = await fetchThrough(url);
  if (!html) continue;
  const rows = parseListing(html);
  console.log(`page ${p}: ${rows.length} products`);
  for (const r of rows) if (!scraped.has(r.iherbId)) scraped.set(r.iherbId, r);
  if (!rows.length) break;
}

const products = [...scraped.values()].filter((p) => p.price).slice(0, LIMIT);
console.log(`\n${products.length} unique products with a price`);
if (!products.length) { console.error('nothing parsed -- aborting rather than writing an empty category'); process.exit(1); }

if (!WRITE) {
  for (const p of products.slice(0, 8)) {
    console.log(`  A$${p.price.toFixed(2)}${p.originalPrice ? ` (was A$${p.originalPrice.toFixed(2)})` : ''}  ${p.brand} | ${p.name.slice(0, 52)}`);
  }
  console.log(`\n[dry-run] nothing written. Re-run with --write.`);
  process.exit(0);
}

/* ---------- upsert ---------- */
let created = 0; let updated = 0; let offersWritten = 0; let failed = 0;

for (const p of products) {
  try {
    const key = p.partNumber || `IHERB-${p.iherbId}`;
    const found = await api(`/api/commerce-products?filters[sku][$eq]=${encodeURIComponent(key)}&populate=categories&fields[0]=sku&fields[1]=tags&pagination[pageSize]=1`);
    const existing = found?.data?.[0];

    const payload = {
      name: p.name,
      /* iHerb id appended because `slug` is unique and several rows here are
         size variants of one product whose names differ only past the
         truncation point ("CollagenUP, Hydrolyzed Marine Collagen, 206 g" vs
         "... 464 g"). Keying on the id keeps re-runs idempotent too. */
      slug: `${slugify(`${p.brand ? `${p.brand} ` : ''}${p.name}`).slice(0, 80)}-${p.iherbId}`,
      brand: p.brand,
      sku: key,
      imageUrl: p.image,
      rating: p.rating,
      ratingCount: p.ratingCount,
      productStatus: 'active',
      site: site.documentId,
      /* The sourcing pipeline selects its work pool by this tag, not by the
         site relation -- resolve-product-ids and fetch-offers-sellers both
         filter on it. Without it these products are invisible to the offer
         search and would sit at one offer forever. */
      tags: [...new Set([...(existing?.tags ?? []), SITE])],
      /* Category membership is additive: a product can legitimately sit in more
         than one category and this import must not evict the others. */
      categories: [...new Set([...(existing?.categories ?? []).map((c) => c.documentId), category.documentId])],
    };

    let doc;
    if (existing) {
      const res = await api(`/api/commerce-products/${existing.documentId}`, { method: 'PUT', body: JSON.stringify({ data: payload }) });
      doc = res.data; updated += 1;
    } else {
      const res = await api('/api/commerce-products', { method: 'POST', body: JSON.stringify({ data: payload }) });
      doc = res.data; created += 1;
    }

    /* iHerb's own offer. Matched on product+merchant so a re-run refreshes the
       price instead of stacking a new offer every night. */
    const offerFind = await api(
      `/api/commerce-offers?filters[product][documentId][$eq]=${doc.documentId}&filters[merchant][documentId][$eq]=${merchant.documentId}&pagination[pageSize]=1`,
    );
    const offerPayload = {
      product: doc.documentId,
      merchant: merchant.documentId,
      title: p.name,
      price: p.price,
      originalPrice: p.originalPrice,
      currency: CURRENCY,
      discountPercent: p.originalPrice ? Math.round((1 - p.price / p.originalPrice) * 100) : null,
      productUrl: p.url,
      availability: 'in_stock',
      condition: 'new',
      merchantSku: p.partNumber,
      source: 'iherb-category-scrape',
      lastCheckedAt: new Date().toISOString(),
      status: 'active',
    };
    if (offerFind?.data?.[0]) {
      await api(`/api/commerce-offers/${offerFind.data[0].documentId}`, { method: 'PUT', body: JSON.stringify({ data: offerPayload }) });
    } else {
      await api('/api/commerce-offers', { method: 'POST', body: JSON.stringify({ data: offerPayload }) });
    }
    offersWritten += 1;
  } catch (err) {
    failed += 1;
    console.error(`  FAILED ${p.name.slice(0, 50)}: ${err.message}`);
  }
}

console.log(`\ncreated ${created}, updated ${updated}, offers written ${offersWritten}, failed ${failed}`);
