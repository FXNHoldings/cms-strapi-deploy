#!/usr/bin/env node
/**
 * Set commerce-product.productStatus from the live offer count.
 *
 *   node scripts/sync-product-listability.mjs --tag=bestlooking-skin              # dry run
 *   node scripts/sync-product-listability.mjs --tag=bestlooking-skin --write
 *   node scripts/sync-product-listability.mjs --category=hyaluronic-acid --write
 *
 * A product with fewer than --min-offers (default 2) live offers is not a price
 * comparison: it is one merchant's price with nothing to check it against. Those
 * rows go to productStatus 'draft' -- kept in the CMS, and still available to
 * the content tooling, but excluded from the storefront, which filters on
 * 'active' in its site-scoped access point.
 *
 * The reverse also runs: a draft product that has since gained a second offer
 * goes back to 'active'. Otherwise the first offer search would park a product
 * out of sight permanently.
 *
 * Never touches 'archived' -- that is a deliberate editorial state, and this
 * script has no business overriding it.
 */
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const TAG = flag('tag', null);
const CATEGORY = flag('category', null);
const MIN = Number(flag('min-offers', 2));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
if (!TOKEN) { console.error('STRAPI_API_TOKEN not set'); process.exit(2); }
if (!TAG && !CATEGORY) { console.error('one of --tag or --category is required'); process.exit(2); }

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${pathname} -> ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

const rows = [];
for (let page = 1; ; page += 1) {
  const q = new URLSearchParams({ 'pagination[page]': String(page), 'pagination[pageSize]': '100' });
  if (TAG) q.append('filters[tags][$containsi]', TAG);
  if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
  q.append('fields[0]', 'name'); q.append('fields[1]', 'productStatus');
  q.append('populate[offers][fields][0]', 'status');
  const res = await api(`/api/commerce-products?${q}`);
  rows.push(...(res?.data ?? []));
  if (page >= (res?.meta?.pagination?.pageCount ?? 1)) break;
}

const changes = [];
for (const p of rows) {
  if (p.productStatus === 'archived') continue;
  /* Only live offers count. An expired or errored offer is not a price a
     reader can act on, so it must not make a product look comparable. */
  const live = (p.offers ?? []).filter((o) => !o.status || o.status === 'active').length;
  const want = live >= MIN ? 'active' : 'draft';
  if (want !== p.productStatus) changes.push({ ...p, live, want });
}

const toDraft = changes.filter((c) => c.want === 'draft');
const toActive = changes.filter((c) => c.want === 'active');
console.log(`${rows.length} products; ${toDraft.length} -> draft, ${toActive.length} -> active (min ${MIN} live offers)`);
for (const c of changes.slice(0, 8)) console.log(`  ${c.productStatus} -> ${c.want}  (${c.live} offers)  ${c.name.slice(0, 52)}`);

if (!WRITE) { console.log('\n[dry-run] nothing written. Re-run with --write.'); process.exit(0); }

let done = 0; let failed = 0;
for (const c of changes) {
  try {
    await api(`/api/commerce-products/${c.documentId}`, { method: 'PUT', body: JSON.stringify({ data: { productStatus: c.want } }) });
    done += 1;
  } catch (err) { failed += 1; console.error(`  FAILED ${c.name.slice(0, 40)}: ${err.message}`); }
}
console.log(`\nupdated ${done}, failed ${failed}`);
