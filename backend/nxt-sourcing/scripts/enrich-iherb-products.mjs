#!/usr/bin/env node
/**
 * Fill in descriptions, identifiers and specs for products imported by
 * import-iherb-category.mjs, from each product's own iHerb page.
 *
 *   node scripts/enrich-iherb-products.mjs --category=hyaluronic-acid            # dry run
 *   node scripts/enrich-iherb-products.mjs --category=hyaluronic-acid --write
 *   node scripts/enrich-iherb-products.mjs --category=hyaluronic-acid --write --limit=5
 *
 * The category listing carries name, brand, price, image and rating but no
 * description and no identifiers -- those live on the product page, one fetch
 * each. That is why the import left 72 products with an empty description.
 *
 * Everything here comes from the page's own schema.org Product block plus its
 * specifications list, not from prose scraping: iHerb publishes description,
 * mpn, sku and gtin12 as structured data, and a UPC read out of a <span> whose
 * class changes next month is not worth having.
 *
 * The gtin matters beyond display. It is the cross-retailer identifier the
 * catalogue has been missing -- 0 of 219 products had one -- and it is an exact
 * key, so offer matching on it cannot mispair two similar products the way
 * title matching can.
 *
 * js_render is mandatory: au.iherb.com rejects a plain premium-proxy fetch with
 * REQS002, so there is no cheaper tier to drop to. One request per product.
 */
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const CATEGORY = flag('category', null);
const TAG = flag('tag', null);
const LIMIT = Number(flag('limit', Infinity));
const CONCURRENCY = Number(flag('concurrency', 3));
const FORCE = args.includes('--force');

import { existsSync, readFileSync } from 'node:fs';
function envFrom(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
}
const env = envFrom('/opt/projects/nxt.discount/.env.local');
const ZEN = process.env.ZENROWS_API_KEY || env.ZENROWS_API_KEY;
const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
if (!ZEN) { console.error('ZENROWS_API_KEY not set'); process.exit(2); }
if (!TOKEN) { console.error('STRAPI_API_TOKEN not set'); process.exit(2); }
if (!CATEGORY && !TAG) { console.error('one of --category or --tag is required'); process.exit(2); }

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${pathname} -> ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

const unescapeHtml = (s) => s
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');
const plain = (s) => unescapeHtml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function fetchThrough(url) {
  const params = new URLSearchParams({
    apikey: ZEN, url, js_render: 'true', premium_proxy: 'true', proxy_country: 'au',
  });
  const res = await fetch(`https://api.zenrows.com/v1/?${params}`, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`ZenRows ${res.status}`);
  return res.text();
}

/** The page's own schema.org Product block. */
function productJsonLd(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    const list = Array.isArray(d) ? d : [d];
    for (const item of list) if (item && item['@type'] === 'Product') return item;
  }
  return null;
}

/**
 * The Specifications list: each <li> is `Label: <span>Value</span>`.
 *
 * The tooltip <div> is removed first -- the shipping-weight row carries a
 * three-sentence explainer inside the same <li>, which otherwise lands in the
 * value and turns a spec table into a paragraph.
 */
function specsFrom(html) {
  const start = html.indexOf('id="product-specs-list"');
  if (start === -1) return {};
  const block = html.slice(start, start + 4000);
  const out = {};
  for (const m of block.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const li = m[1].replace(/<div class="cms-popover-tooltip"[\s\S]*$/i, '');
    const value = plain(li.match(/<span[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '');
    const label = plain(li.split('<span')[0]).replace(/:\s*$/, '');
    if (label && value) out[label] = value;
  }
  return out;
}

/** "Suggested use", "Warnings", "Other ingredients" -- h3 then a detail div. */
function overviewSections(html) {
  const out = {};
  for (const m of html.matchAll(/<h3[^>]*>([\s\S]{0,120}?)<\/h3>\s*<div class="prodOverviewDetail">([\s\S]*?)<\/div>/g)) {
    const key = plain(m[1]);
    const val = plain(m[2]);
    /* A heading that swallowed the whole overview is a parse failure, not a
       section -- skip rather than store a page dump under a bad key. */
    if (key && val && key.length < 60) out[key] = val.slice(0, 2000);
  }
  return out;
}

/* ------------------------------------------------------------------ select */
const rows = [];
for (let page = 1; ; page += 1) {
  const q = new URLSearchParams({ 'pagination[page]': String(page), 'pagination[pageSize]': '100' });
  if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
  if (TAG) q.append('filters[tags][$containsi]', TAG);
  for (const [i, f] of ['name', 'description', 'gtin', 'sku'].entries()) q.append(`fields[${i}]`, f);
  q.append('populate[offers][fields][0]', 'productUrl');
  q.append('populate[offers][fields][1]', 'source');
  const res = await api(`/api/commerce-products?${q}`);
  rows.push(...(res?.data ?? []));
  if (page >= (res?.meta?.pagination?.pageCount ?? 1)) break;
}

const targets = rows
  .map((p) => ({
    ...p,
    url: (p.offers ?? []).find((o) => (o.productUrl || '').includes('iherb.com'))?.productUrl ?? null,
  }))
  .filter((p) => p.url)
  .filter((p) => FORCE || !(p.description || '').trim())
  .slice(0, LIMIT);

console.log(`${rows.length} products in scope; ${targets.length} to enrich${FORCE ? ' (forced)' : ' (missing a description)'}`);
if (!targets.length) process.exit(0);
if (!WRITE) {
  console.log(`\n[dry-run] would fetch ${targets.length} iHerb product pages. Re-run with --write.`);
  process.exit(0);
}

/* ----------------------------------------------------------------- enrich */
let done = 0; let failed = 0; let withGtin = 0;
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor; cursor += 1;
    if (i >= targets.length) return;
    const p = targets[i];
    try {
      const html = await fetchThrough(p.url);
      const ld = productJsonLd(html);
      if (!ld) throw new Error('no Product JSON-LD');

      const technicalSpecs = specsFrom(html);
      const sections = overviewSections(html);
      const description = plain(ld.description || '');
      const gtin = ld.gtin12 || ld.gtin13 || ld.gtin8 || ld.gtin || technicalSpecs.UPC || null;

      const payload = {
        description: description || null,
        /* One sentence for cards and meta descriptions. */
        shortDescription: description ? description.split(/(?<=\.)\s+/).slice(0, 2).join(' ').slice(0, 300) : null,
        gtin: gtin ? String(gtin) : null,
        mpn: ld.mpn ? String(ld.mpn) : null,
        sku: ld.sku ? String(ld.sku) : p.sku,
        rating: ld.aggregateRating?.ratingValue ?? undefined,
        ratingCount: ld.aggregateRating?.reviewCount ?? undefined,
        /* technicalSpecs is the shape the product page reads. The pipeline has
           been writing specs flat at the top level, which is why the specs
           panel has never rendered for any product. */
        specs: {
          technicalSpecs,
          ...(sections['Suggested use'] ? { suggestedUse: sections['Suggested use'] } : {}),
          ...(sections.Warnings ? { warnings: sections.Warnings } : {}),
          ...(sections['Other ingredients'] ? { ingredients: sections['Other ingredients'] } : {}),
          sourceUrl: p.url,
        },
      };
      await api(`/api/commerce-products/${p.documentId}`, { method: 'PUT', body: JSON.stringify({ data: payload }) });
      done += 1;
      if (gtin) withGtin += 1;
      console.log(`  ok  ${gtin ? `gtin ${gtin}` : 'no gtin  '}  ${Object.keys(technicalSpecs).length} specs  ${description.length} chars  ${p.name.slice(0, 40)}`);
    } catch (err) {
      failed += 1;
      console.error(`  ERR ${p.name.slice(0, 48)}: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
console.log(`\nenriched ${done}, with gtin ${withGtin}, failed ${failed}`);
