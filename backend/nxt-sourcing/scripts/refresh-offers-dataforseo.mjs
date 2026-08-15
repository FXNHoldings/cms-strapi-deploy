/**
 * Rebuild one product's offers from DataForSEO Google Shopping sellers.
 *
 *   node scripts/refresh-offers-dataforseo.mjs --slug=<product-slug>            # dry run
 *   node scripts/refresh-offers-dataforseo.mjs --slug=<product-slug> --write
 *   node scripts/refresh-offers-dataforseo.mjs --slug=<slug> --gpid=<id> --write
 *
 * Offers are fetched for a known Google `product_id`, never by searching each
 * merchant for a product name. That is the whole point: the existing catalogue
 * was built by keyword search, which is why a Pixel 6 Pro ended up priced on a
 * Pixel 10 Pro Fold page and a Samsung Z Fold5 alongside it. Sellers returned
 * here are, by construction, sellers *of this product*.
 *
 * The product_id is stored back on the product as googleProductId so the next
 * run is a direct lookup with nothing to resolve.
 *
 * Not every seller is a usable offer. Refurbished, pre-owned and foreign-domain
 * listings are excluded rather than imported and priced as if new — mixing them
 * is what made the old data untrustworthy.
 *
 * Measured cost: google/products $0.001 to resolve an id, google/sellers $0.001
 * per product on the standard queue.
 */
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const SLUG = flag('slug', null);
const GPID_ARG = flag('gpid', null);
const PRIORITY = Number(flag('priority', 2));
const LOCATION = Number(flag('location', 2840));
const LANGUAGE = flag('language', 'en');

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';

if (!SLUG) { console.error('usage: --slug=<product-slug> [--gpid=<id>] [--write]'); process.exit(1); }

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

async function dfs(base, payload) {
  const post = await fetch(`${base}/task_post`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ ...payload, priority: PRIORITY }]),
    signal: AbortSignal.timeout(120_000),
  });
  const task = (await post.json()).tasks?.[0];
  if (task?.status_code !== 20100 || !task.id) throw new Error(`${task?.status_code}: ${task?.status_message}`);
  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    try {
      const r = await fetch(`${base}/task_get/advanced/${task.id}`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) {
        const t = (await r.json()).tasks?.[0];
        if (t?.status_code === 20000) return t.result?.[0] ?? null;
        if (t && t.status_code !== 40602) throw new Error(`${t.status_code}: ${t.status_message}`);
      }
    } catch (e) { if (!/aborted|timeout|fetch failed/i.test(String(e.message))) throw e; }
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 8_000));
  }
}

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/* Listings that are not this product, new, from a US storefront. */
const CONDITION_BAD = /refurb|renewed|restored|pre-?owned|used|open box|for parts/i;
const FOREIGN_TLD = /\.(co\.uk|uk|de|fr|it|es|ca|au|in|jp|cn)$/i;

function usableSellers(result) {
  const kept = []; const skipped = [];
  for (const s of result?.items ?? []) {
    const name = s.title ?? s.domain ?? 'Unknown';
    const price = typeof s.base_price === 'number' ? s.base_price : (typeof s.price === 'number' ? s.price : null);
    const cond = String(s.product_condition ?? '');
    const domain = String(s.domain ?? '');
    if (price === null) { skipped.push([name, 'no price']); continue; }
    if (CONDITION_BAD.test(cond) || CONDITION_BAD.test(name)) { skipped.push([name, `condition: ${cond || 'in name'}`]); continue; }
    if (FOREIGN_TLD.test(domain)) { skipped.push([name, `non-US domain: ${domain}`]); continue; }
    const { merchant, seller } = merchantIdentity(name, s.domain);
    kept.push({ name, merchant, seller, price, currency: s.currency ?? 'USD', url: s.url ?? null, domain });
  }
  return { kept, skipped };
}

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);

/*
 * Google names marketplace listings "eBay - moderntek" or "Walmart - HotDeals":
 * the storefront plus the third-party seller. Taking that verbatim creates a new
 * merchant record per seller, so one marketplace fragments into dozens and the
 * merchant list stops meaning anything. The marketplace is the merchant; the
 * seller belongs in the offer title.
 */
function merchantIdentity(rawName, domain) {
  const host = String(domain || '').replace(/^www\./, '').toLowerCase();
  const KNOWN = {
    'ebay.com': 'eBay', 'walmart.com': 'Walmart', 'amazon.com': 'Amazon',
    'bestbuy.com': 'Best Buy', 'target.com': 'Target', 'newegg.com': 'Newegg',
    'microcenter.com': 'Micro Center', 'bhphotovideo.com': 'B&H Photo',
    'adorama.com': 'Adorama', 'costco.com': 'Costco',
  };
  if (KNOWN[host]) return { merchant: KNOWN[host], seller: String(rawName).split(' - ').slice(1).join(' - ') || null };
  const [head, ...rest] = String(rawName).split(' - ');
  return { merchant: head.trim(), seller: rest.join(' - ') || null };
}

/* ------------------------------------------------------------------ main -- */

const found = await strapi(`/api/commerce-products?filters[slug][$eq]=${encodeURIComponent(SLUG)}&fields[0]=name&fields[1]=googleProductId&populate[site][fields][0]=domain`);
const product = found?.data?.[0];
if (!product) { console.error(`No product with slug ${SLUG}`); process.exit(1); }
console.log(`product : ${product.name}`);

let gpid = GPID_ARG ?? product.googleProductId ?? null;
if (!gpid) {
  console.log('resolving google product id by name ...');
  const res = await dfs('https://api.dataforseo.com/v3/merchant/google/products', {
    keyword: product.name, location_code: LOCATION, language_code: LANGUAGE, depth: 20,
  });
  const hit = (res?.items ?? []).find((i) => i?.product_id && i?.title);
  if (!hit) { console.error('could not resolve a product_id — pass --gpid=<id>'); process.exit(1); }
  gpid = String(hit.product_id);
  console.log(`  resolved: ${gpid}  (${hit.title})`);
}
console.log(`gpid    : ${gpid}`);

const sellersResult = await dfs('https://api.dataforseo.com/v3/merchant/google/sellers', {
  product_id: gpid, location_code: LOCATION, language_code: LANGUAGE,
});
const { kept, skipped } = usableSellers(sellersResult);

console.log(`\nusable offers (${kept.length}):`);
for (const k of kept) console.log(`   $${String(k.price).padStart(9)}  ${k.name.slice(0, 26).padEnd(26)} ${k.domain}`);
if (skipped.length) {
  console.log(`\nexcluded (${skipped.length}):`);
  for (const [n, why] of skipped) console.log(`   ${n.slice(0, 30).padEnd(30)} ${why}`);
}

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write.'); process.exit(0); }

/* -------------------------------------------------------------- write -- */

async function ensureMerchant(name) {
  const slug = slugify(name);
  const hit = await strapi(`/api/commerce-merchants?filters[slug][$eq]=${slug}&pagination[pageSize]=1`);
  if (hit?.data?.length) return hit.data[0].documentId;
  const made = await strapi('/api/commerce-merchants', {
    method: 'POST',
    body: JSON.stringify({ data: { name, slug, country: 'US', merchantStatus: 'active' } }),
  });
  console.log(`   + merchant created: ${name}`);
  return made.data.documentId;
}

await strapi(`/api/commerce-products/${product.documentId}?status=published`, {
  method: 'PUT', body: JSON.stringify({ data: { googleProductId: gpid } }),
});

let created = 0;
for (const k of kept) {
  const merchantId = await ensureMerchant(k.merchant);
  await strapi('/api/commerce-offers', {
    method: 'POST',
    body: JSON.stringify({ data: {
      title: `${product.name} at ${k.merchant}${k.seller ? ` (${k.seller})` : ''}`.slice(0, 255),
      price: k.price, currency: k.currency,
      productUrl: k.url, availability: 'in_stock', condition: 'new',
      source: 'dataforseo-google-sellers',
      lastCheckedAt: new Date().toISOString(), status: 'active',
      product: product.documentId, merchant: merchantId,
    } }),
  });
  created++;
}
console.log(`\ncreated ${created} offer(s); googleProductId stored on the product.`);
