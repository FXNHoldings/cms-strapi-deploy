/**
 * Rebuild offers from `merchant/google/sellers`, keyed on each product's stored
 * googleProductId.
 *
 *   node scripts/fetch-offers-sellers.mjs                      # dry run, all products
 *   node scripts/fetch-offers-sellers.mjs --write
 *   node scripts/fetch-offers-sellers.mjs --write --category=smart-phones
 *   node scripts/fetch-offers-sellers.mjs --write --thin-only  # products with <2 offers
 *
 * The sourcing pipeline prices a product by searching its *name*, which means
 * every result has to be title-matched — the source of every mismatch fixed in
 * this codebase (an A26 sold as an S26, an M5 Pro priced as an M5). This endpoint
 * takes a product id and returns sellers of *that product*, so no title matching
 * is needed at all, and it returns real domains and storefront URLs rather than
 * the nulls the search endpoint gives.
 *
 * Measured on a 10-product sample of thin listings: 8 existing offers against 38
 * available sellers. The gain is uneven — iPhones went 1 -> 10, the Pixel 11
 * family gained nothing, and 2 of 10 returned no results at all.
 *
 * Offers previously written by either DataForSEO source are replaced, so a
 * re-run refreshes prices instead of stacking duplicates.
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
const THIN_ONLY = args.includes('--thin-only');
/* Only products with no offers at all. Narrower than --thin-only, which also
 * picks up single-offer products and quadruples the spend. */
const NO_OFFERS_ONLY = args.includes('--no-offers-only');
const CATEGORY = flag('category', null);
const LIMIT = Number(flag('limit', Infinity));
const PRIORITY = Number(flag('priority', 1));
const LOCATION = Number(flag('location', 2840));
const LANGUAGE = flag('language', 'en');
const CONCURRENCY = Number(flag('concurrency', 8));
const MIN_PRICE = Number(flag('min-price', 5));
const OUT = path.join(ROOT, 'reports', `offers-sellers-${CATEGORY ?? 'all'}.json`);

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const EP = 'https://api.dataforseo.com/v3/merchant/google/sellers';

/**
 * US retailers whose prices belong on a comparison page, keyed by domain.
 *
 * Domain is a far better key than the seller name: this endpoint returns both,
 * and "Amazon.com - Seller" or "Best Buy on eBay" defeat name matching while
 * their domains do not.
 */
const RETAILERS = [
  { name: 'Best Buy', tier: 1, domains: ['bestbuy.com'] },
  { name: 'Walmart', tier: 1, domains: ['walmart.com'] },
  { name: 'Target', tier: 1, domains: ['target.com'] },
  { name: 'Costco', tier: 1, domains: ['costco.com'] },
  { name: "Sam's Club", tier: 1, domains: ['samsclub.com'] },
  { name: 'Newegg', tier: 1, domains: ['newegg.com'] },
  { name: 'Micro Center', tier: 1, domains: ['microcenter.com'] },
  { name: 'B&H Photo', tier: 1, domains: ['bhphotovideo.com'] },
  { name: 'Adorama', tier: 1, domains: ['adorama.com'] },
  { name: 'Home Depot', tier: 1, domains: ['homedepot.com'] },
  { name: "Lowe's", tier: 1, domains: ['lowes.com'] },
  { name: 'Staples', tier: 1, domains: ['staples.com'] },
  { name: 'Office Depot', tier: 1, domains: ['officedepot.com'] },
  { name: "Kohl's", tier: 1, domains: ['kohls.com'] },
  { name: "Macy's", tier: 1, domains: ['macys.com'] },
  { name: 'Nebraska Furniture Mart', tier: 1, domains: ['nfm.com'] },
  { name: 'Zoro', tier: 1, domains: ['zoro.com'] },
  { name: 'Crutchfield', tier: 1, domains: ['crutchfield.com'] },
  { name: 'Abt', tier: 1, domains: ['abt.com'] },
  { name: 'Apple', tier: 2, domains: ['apple.com'] },
  { name: 'Samsung', tier: 2, domains: ['samsung.com'] },
  { name: 'Google Store', tier: 2, domains: ['store.google.com'] },
  { name: 'Motorola', tier: 2, domains: ['motorola.com'] },
  { name: 'OnePlus Official Store', tier: 2, domains: ['oneplus.com'] },
  { name: 'Sonos', tier: 2, domains: ['sonos.com'] },
  { name: 'Anker', tier: 2, domains: ['anker.com'] },
  { name: 'eufy', tier: 2, domains: ['eufy.com', 'eufylife.com'] },
  { name: 'Ring', tier: 2, domains: ['ring.com'] },
  { name: 'Reolink', tier: 2, domains: ['reolink.com'] },
  { name: 'Dreame', tier: 2, domains: ['dreametech.com'] },
  { name: 'Garmin', tier: 2, domains: ['garmin.com'] },
  { name: 'Dell', tier: 2, domains: ['dell.com'] },
  { name: 'HP', tier: 2, domains: ['hp.com'] },
  { name: 'Lenovo', tier: 2, domains: ['lenovo.com'] },
  { name: 'Asus', tier: 2, domains: ['asus.com'] },
  { name: 'LG', tier: 2, domains: ['lg.com'] },
  { name: 'Sony', tier: 2, domains: ['sony.com', 'electronics.sony.com'] },
  { name: 'Raspberry Pi', tier: 2, domains: ['raspberrypi.com'] },
  { name: 'TP-Link', tier: 2, domains: ['tp-link.com', 'tplink.com'] },
  { name: 'Govee', tier: 2, domains: ['govee.com'] },
  { name: 'Aqara', tier: 2, domains: ['aqara.com'] },
  { name: 'Amazon', tier: 3, domains: ['amazon.com'] },
  { name: 'eBay', tier: 3, domains: ['ebay.com'] },
];

const BY_DOMAIN = new Map();
for (const r of RETAILERS) for (const d of r.domains) BY_DOMAIN.set(d, r);

/** Carriers quote a monthly instalment, not the purchase price. */
const CARRIER_DOMAINS = /(att|verizon|t-mobile|tmobile|boostmobile|cricketwireless|xfinity|spectrum|uscellular|visible|mintmobile)\.com$/i;
const CONDITION_BAD = /refurb|renewed|restored|pre-?owned|\bused\b|open box|for parts|grade [abc]\b/i;
const ENCUMBERED = /\b(missing|cracked|damaged|broken|faulty|salvage|as-?is|parts only|bad esn|blacklist|past_?due|icloud ?locked|activation ?locked|can'?t activate|carrier locked|sim locked|bad imei)\b/i;

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

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);

function usableSellers(result) {
  const kept = [];
  for (const s of result?.items ?? []) {
    const price = typeof s.base_price === 'number' ? s.base_price
      : typeof s.price === 'number' ? s.price : null;
    if (price === null || price < MIN_PRICE) continue;

    const name = String(s.title ?? s.domain ?? '');
    if (CONDITION_BAD.test(String(s.product_condition ?? '')) || CONDITION_BAD.test(name)) continue;
    if (ENCUMBERED.test(name)) continue;

    const host = String(s.domain ?? '').replace(/^www\./, '').toLowerCase();
    if (CARRIER_DOMAINS.test(host) && price < 200) continue;   // monthly instalment

    const retailer = BY_DOMAIN.get(host);
    if (!retailer) continue;                                   // outside the allowlist

    kept.push({
      merchant: retailer.name,
      tier: retailer.tier,
      // On a marketplace the storefront name is the seller, not the merchant.
      seller: retailer.tier === 3 ? (String(s.title ?? '').split(' - ').slice(1).join(' - ') || null) : null,
      price,
      currency: s.currency ?? 'USD',
      url: s.url ?? null,
      domain: host,
    });
  }

  /*
   * A price far from the consensus is a bundle, a contract or a data error. Needs
   * four prices before a median means anything, so small sets pass untouched.
   */
  let out = kept;
  if (out.length >= 4) {
    const sorted = out.map((o) => o.price).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median) out = out.filter((o) => o.price <= median * 2.5 && o.price >= median * 0.35);
  }

  // One row per merchant, cheapest kept — the product page collapses them anyway.
  const best = new Map();
  for (const o of out.sort((a, b) => a.price - b.price)) if (!best.has(o.merchant)) best.set(o.merchant, o);
  return [...best.values()].sort((a, b) => a.price - b.price);
}

/* --------------------------------------------------------------------- main */

if (!DFS_LOGIN || !DFS_PASSWORD) { console.error('DATAFORSEO credentials not set.'); process.exit(1); }

const q = new URLSearchParams({ 'pagination[pageSize]': '1000', status: 'published' });
q.append('filters[tags][$containsi]', 'nxt-bargains');
if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
for (const [i, f] of ['name', 'slug', 'googleProductId'].entries()) q.append(`fields[${i}]`, f);
q.append('populate[offers][fields][0]', 'price');

const list = await strapi(`/api/commerce-products?${q}`);
let products = (list?.data ?? []).filter((p) => p.googleProductId);
if (NO_OFFERS_ONLY) products = products.filter((p) => (p.offers ?? []).length === 0);
else if (THIN_ONLY) products = products.filter((p) => (p.offers ?? []).length < 2);
products = products.slice(0, LIMIT);

console.log(`products : ${products.length}`);
console.log(`estimate : $${(products.length * 0.001 * (PRIORITY === 2 ? 2 : 1)).toFixed(3)}`);
console.log(`mode     : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);
if (!products.length) process.exit(0);

const byTag = new Map();
for (let i = 0; i < products.length; i += 100) {
  const batch = products.slice(i, i + 100);
  let res = null;
  for (let attempt = 1; attempt <= 4 && !res; attempt += 1) {
    try {
      const r = await fetch(`${EP}/task_post`, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map((p) => ({
          product_id: p.googleProductId, location_code: LOCATION, language_code: LANGUAGE,
          tag: p.slug, priority: PRIORITY,
        }))),
        signal: AbortSignal.timeout(180_000),
      });
      if (r.ok) res = r; else console.log(`   task_post HTTP ${r.status}, retry ${attempt}/4`);
    } catch (e) { console.log(`   task_post ${e.name ?? e.message}, retry ${attempt}/4`); }
    if (!res) await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  if (!res) throw new Error('task_post failed after 4 attempts');
  for (const t of (await res.json()).tasks ?? []) {
    const tag = t.data?.tag ?? null;
    byTag.set(tag, t.status_code === 20100 && t.id ? { id: t.id } : { error: `${t.status_code}: ${t.status_message}` });
  }
  process.stdout.write(`  posted ${Math.min(i + 100, products.length)}/${products.length}\r`);
}
process.stdout.write('\n');

const deadline = Date.now() + 50 * 60 * 1000;
const pending = [...byTag.entries()].filter(([, v]) => v.id);
let done = 0;
await pool(pending, CONCURRENCY, async ([tag, v]) => {
  for (;;) {
    try {
      const r = await fetch(`${EP}/task_get/advanced/${v.id}`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(90_000) });
      const text = await r.text();
      if (r.ok && text.trim().startsWith('{')) {
        const t = JSON.parse(text).tasks?.[0];
        if (t?.status_code === 20000) { byTag.set(tag, { result: t.result?.[0] ?? null }); break; }
        if (t && t.status_code !== 40602) { byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` }); break; }
      }
    } catch (e) { if (!/aborted|timeout|fetch failed|JSON/i.test(String(e.message))) throw e; }
    if (Date.now() > deadline) { byTag.set(tag, { error: 'timed out' }); break; }
    await new Promise((res) => setTimeout(res, 10_000));
  }
  if (++done % 20 === 0 || done === pending.length) process.stdout.write(`  collected ${done}/${pending.length}\r`);
});
process.stdout.write('\n');

const findings = [];
for (const p of products) {
  const got = byTag.get(p.slug);
  findings.push({
    slug: p.slug, name: p.name,
    before: (p.offers ?? []).length,
    error: got?.error ?? null,
    offers: got?.error ? [] : usableSellers(got?.result),
  });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));

const gained = findings.filter((f) => f.offers.length > f.before).length;
const noResult = findings.filter((f) => f.error).length;
console.log(`before: ${findings.reduce((n, f) => n + f.before, 0)} offers   after: ${findings.reduce((n, f) => n + f.offers.length, 0)} offers`);
console.log(`products improved: ${gained}   no seller data: ${noResult}`);
console.log(`report: ${OUT}`);

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write.'); process.exit(0); }

const merchantCache = new Map();
async function ensureMerchant(name) {
  if (merchantCache.has(name)) return merchantCache.get(name);
  const slug = slugify(name);
  const hit = await strapi(`/api/commerce-merchants?filters[slug][$eq]=${slug}&pagination[pageSize]=1`);
  let id = hit?.data?.[0]?.documentId;
  if (!id) {
    const made = await strapi('/api/commerce-merchants', {
      method: 'POST',
      body: JSON.stringify({ data: { name, slug, country: 'US', merchantStatus: 'active' } }),
    });
    id = made.data.documentId;
  }
  merchantCache.set(name, id);
  return id;
}

let created = 0, removed = 0, failed = 0;
for (const f of findings) {
  if (f.error || !f.offers.length) continue;
  const prod = await strapi(`/api/commerce-products?filters[slug][$eq]=${encodeURIComponent(f.slug)}&pagination[pageSize]=1&status=published`);
  const productId = prod?.data?.[0]?.documentId;
  if (!productId) continue;

  /*
   * Merge, do not replace.
   *
   * A first draft deleted every DataForSEO offer before writing the new set, and
   * a dry run showed why that is wrong: this endpoint returns nothing at all for
   * some products (40102) and fewer sellers than the name search for others, so
   * a straight replace would have destroyed working offers — 35 down to 27 on a
   * twelve-product sample. Only merchants present in the new data are refreshed;
   * everything else is left alone, so coverage can never go backwards.
   */
  const fresh = new Set(f.offers.map((o) => o.merchant));
  const old = await strapi(`/api/commerce-offers?filters[product][slug][$eq]=${encodeURIComponent(f.slug)}&filters[source][$startsWith]=dataforseo&populate[merchant][fields][0]=name&pagination[pageSize]=100&status=published`);
  for (const o of old?.data ?? []) {
    if (!fresh.has(o.merchant?.name)) continue;
    try { await strapi(`/api/commerce-offers/${o.documentId}`, { method: 'DELETE' }); removed += 1; } catch { /* already gone */ }
  }

  for (const o of f.offers) {
    try {
      const merchantId = await ensureMerchant(o.merchant);
      await strapi('/api/commerce-offers', {
        method: 'POST',
        body: JSON.stringify({ data: {
          title: `${f.name} at ${o.merchant}${o.seller ? ` (${o.seller})` : ''}`.slice(0, 255),
          price: o.price, currency: o.currency, productUrl: o.url,
          availability: 'in_stock', condition: 'new',
          source: 'dataforseo-google-sellers',
          lastCheckedAt: new Date().toISOString(), status: 'active',
          product: productId, merchant: merchantId,
        } }),
      });
      created += 1;
    } catch (e) { failed += 1; console.log(`   ! ${f.slug} / ${o.merchant}: ${String(e.message).slice(0, 90)}`); }
  }
}

console.log(`\nremoved ${removed} superseded offer(s); created ${created}${failed ? `; ${failed} failed` : ''}.`);
