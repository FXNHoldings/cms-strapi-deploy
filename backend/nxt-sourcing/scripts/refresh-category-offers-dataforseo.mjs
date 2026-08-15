/**
 * Rebuild offers for a whole category from DataForSEO Google Shopping sellers.
 *
 *   node scripts/refresh-category-offers-dataforseo.mjs --category=smart-phones
 *   node scripts/refresh-category-offers-dataforseo.mjs --category=smart-phones --write
 *   ... --skip=<slug>[,<slug>]   --limit=10   --reviews
 *
 * Three batched phases, because tasks post 100 at a time and poll in parallel —
 * the queue wait is paid once for the run rather than once per product:
 *
 *   1. resolve  google/products  name -> product_id   (skipped where stored)
 *   2. sellers  google/sellers   product_id -> offers
 *   3. reviews  google/product_info -> gid, then google/reviews  (--reviews)
 *
 * Offers are always fetched for a known product_id, never by searching each
 * merchant for a name. That is what stopped a Pixel 6 Pro appearing on a Pixel
 * 10 Pro Fold page: the sellers returned are sellers of *this* product.
 *
 * Refurbished, pre-owned and non-US listings are excluded rather than priced as
 * new. Marketplace seller names are folded back to the marketplace, so "eBay -
 * moderntek" does not create a merchant record per seller.
 *
 * Measured cost, standard queue: $0.001 per request. A 94-product category is
 * about $0.19 for prices, $0.28 with reviews.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const WANT_REVIEWS = args.includes('--reviews');
const CATEGORY = flag('category', null);
const SKIP = (flag('skip', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(flag('limit', Infinity));
const PRIORITY = Number(flag('priority', 1));
const LOCATION = Number(flag('location', 2840));
const LANGUAGE = flag('language', 'en');
const CONCURRENCY = Number(flag('concurrency', 8));
const OUT = flag('out', path.join(ROOT, 'reports', `category-offers-${CATEGORY ?? 'all'}.json`));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';

if (!CATEGORY) { console.error('usage: --category=<slug> [--skip=a,b] [--reviews] [--write]'); process.exit(1); }

const EP = {
  products: 'https://api.dataforseo.com/v3/merchant/google/products',
  sellers: 'https://api.dataforseo.com/v3/merchant/google/sellers',
  info: 'https://api.dataforseo.com/v3/merchant/google/product_info',
  reviews: 'https://api.dataforseo.com/v3/merchant/google/reviews',
};

function authHeader() {
  const pw = DFS_PASSWORD.trim();
  if (/^[A-Za-z0-9+/=]+$/.test(pw) && pw.length > 16) {
    try {
      const [l, ...rest] = Buffer.from(pw, 'base64').toString('utf8').split(':');
      if (rest.length && l.includes('@')) return `Basic ${pw}`;
    } catch { /* not base64 */ }
  }
  return `Basic ${Buffer.from(`${DFS_LOGIN}:${pw}`).toString('base64')}`;
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { await worker(items[i]); } catch { /* per item */ } }
  }));
}

const calls = { products: 0, sellers: 0, info: 0, reviews: 0 };

/** Post tasks in batches of 100, then poll every one. Returns Map(tag -> result). */
async function runTasks(kind, payloads) {
  const base = EP[kind];
  const byTag = new Map();
  for (let i = 0; i < payloads.length; i += 100) {
    const batch = payloads.slice(i, i + 100);
    const res = await fetch(`${base}/task_post`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map((b) => ({ ...b.payload, tag: b.tag, priority: PRIORITY }))),
      signal: AbortSignal.timeout(120_000),
    });
    calls[kind] += batch.length;
    if (!res.ok) throw new Error(`${kind} task_post HTTP ${res.status}`);
    for (const t of (await res.json()).tasks ?? []) {
      const tag = t.data?.tag ?? null;
      byTag.set(tag, t.status_code === 20100 && t.id ? { id: t.id } : { error: `${t.status_code}: ${t.status_message}` });
    }
  }
  const deadline = Date.now() + 45 * 60 * 1000;
  const pending = [...byTag.entries()].filter(([, v]) => v.id);
  let done = 0;
  await pool(pending, CONCURRENCY, async ([tag, v]) => {
    for (;;) {
      try {
        const r = await fetch(`${base}/task_get/advanced/${v.id}`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(90_000) });
        if (r.ok) {
          const t = (await r.json()).tasks?.[0];
          if (t?.status_code === 20000) { byTag.set(tag, { result: t.result?.[0] ?? null }); break; }
          if (t && t.status_code !== 40602) { byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` }); break; }
        }
      } catch (e) { if (!/aborted|timeout|fetch failed/i.test(String(e.message))) throw e; }
      if (Date.now() > deadline) { byTag.set(tag, { error: 'timed out' }); break; }
      await new Promise((res) => setTimeout(res, 10_000));
    }
    if (++done % 20 === 0 || done === pending.length) process.stdout.write(`    ${done}/${pending.length}\r`);
  });
  if (pending.length) process.stdout.write('\n');
  return byTag;
}

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const CONDITION_BAD = /refurb|renewed|restored|pre-?owned|used|open box|for parts/i;
const FOREIGN_TLD = /\.(co\.uk|uk|de|fr|it|es|ca|au|in|jp|cn)$/i;
const KNOWN_MARKETPLACES = {
  'ebay.com': 'eBay', 'walmart.com': 'Walmart', 'amazon.com': 'Amazon',
  'bestbuy.com': 'Best Buy', 'target.com': 'Target', 'newegg.com': 'Newegg',
  'microcenter.com': 'Micro Center', 'bhphotovideo.com': 'B&H Photo',
  'adorama.com': 'Adorama', 'costco.com': 'Costco',
};

/** "eBay - moderntek" is one marketplace and one seller, not a new merchant. */
function merchantIdentity(rawName, domain) {
  const host = String(domain || '').replace(/^www\./, '').toLowerCase();
  if (KNOWN_MARKETPLACES[host]) {
    return { merchant: KNOWN_MARKETPLACES[host], seller: String(rawName).split(' - ').slice(1).join(' - ') || null };
  }
  const [head, ...rest] = String(rawName).split(' - ');
  return { merchant: head.trim(), seller: rest.join(' - ') || null };
}

function usableSellers(result) {
  const kept = [];
  for (const s of result?.items ?? []) {
    const name = s.title ?? s.domain ?? 'Unknown';
    const price = typeof s.base_price === 'number' ? s.base_price : (typeof s.price === 'number' ? s.price : null);
    if (price === null) continue;
    if (CONDITION_BAD.test(String(s.product_condition ?? '')) || CONDITION_BAD.test(name)) continue;
    if (FOREIGN_TLD.test(String(s.domain ?? ''))) continue;
    const { merchant, seller } = merchantIdentity(name, s.domain);
    if (isInstalmentPrice(merchant, price)) continue;
    kept.push({ merchant, seller, price, currency: s.currency ?? 'USD', url: s.url ?? null });
  }
  return dedupePerMerchant(rejectOutliers(kept));
}

/*
 * Carriers quote the monthly instalment, not the purchase price. Google returns
 * it as the price with nothing marking it as a payment plan, so a Moto G came
 * back at $8.20 and an iPhone 17 Pro at $36.11 — a headline "from" price that is
 * off by twenty-four times and reads as a real bargain.
 *
 * A phone under $200 from a carrier is a monthly figure, not a handset price.
 * This has to run per-offer rather than as an outlier check, because the
 * outlier filter needs four prices and most of these products have one.
 */
const CARRIERS = new Set([
  'AT&T', 'Verizon', 'T-Mobile', 'T-Mobile for Business', 'Cricket Wireless',
  'Boost Mobile', 'Straight Talk', 'Total Wireless', 'Visible', 'Go Talk Wireless',
  'US Cellular', 'Metro by T-Mobile', 'Xfinity Mobile', 'Spectrum Mobile',
]);
function isInstalmentPrice(merchant, price) {
  return CARRIERS.has(merchant) && price < 200;
}

/*
 * A listing far from the consensus is almost never the same deal: it is a
 * contract price, a bundle, or a multi-pack. One Pixel 8 Pro came back at $999
 * against a $433 median from ten sellers, which as a headline "from" price
 * misleads exactly the way the carrier-instalment prices did.
 *
 * Needs at least four prices to have a usable median, so small result sets are
 * left alone rather than trimmed on weak evidence.
 */
function rejectOutliers(offers) {
  if (offers.length < 4) return offers;
  const sorted = [...offers].map((o) => o.price).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!median) return offers;
  return offers.filter((o) => o.price <= median * 2 && o.price >= median * 0.4);
}

/*
 * One row per merchant, cheapest kept. Ten eBay listings from ten sellers are
 * one merchant's price to a reader, and the product page collapses them anyway
 * — storing all ten just inflates the table and the offer count.
 */
function dedupePerMerchant(offers) {
  const best = new Map();
  for (const o of [...offers].sort((a, b) => a.price - b.price)) {
    if (!best.has(o.merchant)) best.set(o.merchant, o);
  }
  return [...best.values()];
}

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);

/* ------------------------------------------------------------------ main -- */

if (!DFS_LOGIN || !DFS_PASSWORD) { console.error('DATAFORSEO credentials not set.'); process.exit(1); }

const q = new URLSearchParams({ 'pagination[pageSize]': '200' });
q.append('filters[categories][slug][$eq]', CATEGORY);
q.append('fields[0]', 'name'); q.append('fields[1]', 'slug'); q.append('fields[2]', 'googleProductId');
const list = await strapi(`/api/commerce-products?${q}`);
let products = (list?.data ?? []).filter((p) => !SKIP.includes(p.slug)).slice(0, LIMIT);

console.log(`category : ${CATEGORY}`);
console.log(`products : ${products.length}${SKIP.length ? ` (skipping ${SKIP.length})` : ''}`);
const needResolve = products.filter((p) => !p.googleProductId);
console.log(`resolve  : ${needResolve.length} without a stored googleProductId`);
const est = (needResolve.length + products.length + (WANT_REVIEWS ? products.length : 0)) * 0.001 * (PRIORITY === 2 ? 2 : 1);
console.log(`estimate : $${est.toFixed(3)}`);
console.log(`mode     : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);

/* phase 1 — resolve ids */
const gpid = new Map(products.filter((p) => p.googleProductId).map((p) => [p.slug, String(p.googleProductId)]));
if (needResolve.length) {
  console.log(`resolving ${needResolve.length} product ids ...`);
  const out = await runTasks('products', needResolve.map((p) => ({
    tag: p.slug, payload: { keyword: p.name, location_code: LOCATION, language_code: LANGUAGE, depth: 10 },
  })));
  for (const p of needResolve) {
    const r = out.get(p.slug);
    const hit = (r?.result?.items ?? []).find((i) => i?.product_id && i?.title);
    if (hit) gpid.set(p.slug, String(hit.product_id));
  }
  console.log(`  resolved ${gpid.size - (products.length - needResolve.length)} of ${needResolve.length}`);
}

/* phase 2 — sellers */
const withId = products.filter((p) => gpid.has(p.slug));
console.log(`\nfetching sellers for ${withId.length} products ...`);
const sellersOut = await runTasks('sellers', withId.map((p) => ({
  tag: p.slug, payload: { product_id: gpid.get(p.slug), location_code: LOCATION, language_code: LANGUAGE },
})));

const findings = withId.map((p) => {
  const r = sellersOut.get(p.slug);
  return { slug: p.slug, name: p.name, documentId: p.documentId, gpid: gpid.get(p.slug),
           offers: r?.error ? [] : usableSellers(r?.result), error: r?.error ?? null };
});

const totalOffers = findings.reduce((n, f) => n + f.offers.length, 0);
console.log(`  usable offers: ${totalOffers} across ${findings.filter((f) => f.offers.length).length} products`);

/* phase 3 — reviews (optional) */
let reviewable = [];
if (WANT_REVIEWS) {
  console.log(`\nchecking review availability for ${withId.length} products ...`);
  const infoOut = await runTasks('info', withId.map((p) => ({
    tag: p.slug, payload: { product_id: gpid.get(p.slug), location_code: LOCATION, language_code: LANGUAGE },
  })));
  for (const p of withId) {
    const item = (infoOut.get(p.slug)?.result?.items ?? [])[0];
    if (item?.gid) reviewable.push({ slug: p.slug, gid: item.gid });
  }
  console.log(`  products with a review gid: ${reviewable.length} of ${withId.length}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), category: CATEGORY, calls, findings, reviewable }, null, 2)}\n`);
console.log(`\nreport: ${OUT}`);

if (!WRITE) {
  console.log('\nDry run — nothing written. Re-run with --write.');
  process.exit(0);
}

/* ----------------------------------------------------------------- write -- */

const merchantCache = new Map();
async function ensureMerchant(name) {
  const slug = slugify(name);
  if (merchantCache.has(slug)) return merchantCache.get(slug);
  const hit = await strapi(`/api/commerce-merchants?filters[slug][$eq]=${slug}&pagination[pageSize]=1`);
  let id = hit?.data?.[0]?.documentId;
  if (!id) {
    const made = await strapi('/api/commerce-merchants', {
      method: 'POST', body: JSON.stringify({ data: { name, slug, country: 'US', merchantStatus: 'active' } }),
    });
    id = made.data.documentId;
  }
  merchantCache.set(slug, id);
  return id;
}

let createdOffers = 0; let stamped = 0;
for (const f of findings) {
  if (f.gpid) {
    await strapi(`/api/commerce-products/${f.documentId}?status=published`, {
      method: 'PUT', body: JSON.stringify({ data: { googleProductId: f.gpid } }),
    }).then(() => { stamped++; }).catch(() => {});
  }
  for (const o of f.offers) {
    const merchantId = await ensureMerchant(o.merchant);
    await strapi('/api/commerce-offers', {
      method: 'POST',
      body: JSON.stringify({ data: {
        title: `${f.name} at ${o.merchant}${o.seller ? ` (${o.seller})` : ''}`.slice(0, 255),
        price: o.price, currency: o.currency, productUrl: o.url,
        availability: 'in_stock', condition: 'new', source: 'dataforseo-google-sellers',
        lastCheckedAt: new Date().toISOString(), status: 'active',
        product: f.documentId, merchant: merchantId,
      } }),
    }).then(() => { createdOffers++; }).catch((e) => console.log(`  offer failed for ${f.slug}: ${e.message}`));
  }
}
console.log(`\ncreated ${createdOffers} offers; stored googleProductId on ${stamped} products.`);
console.log(`calls: ${JSON.stringify(calls)}  ~$${Object.values(calls).reduce((a, b) => a + b, 0) * 0.001 * (PRIORITY === 2 ? 2 : 1)}`);
