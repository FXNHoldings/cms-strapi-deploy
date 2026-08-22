/**
 * Resolve a googleProductId for products that do not have one, by searching
 * Google Shopping for the product's name.
 *
 *   node scripts/resolve-product-ids.mjs --limit=50            # dry run
 *   node scripts/resolve-product-ids.mjs --limit=50 --write
 *   node scripts/resolve-product-ids.mjs --category=tablets --write
 *
 * Products imported from a spec sheet have no id, so `fetch-offers-sellers.mjs`
 * cannot price them. This fills that gap, and only that gap: once an id is
 * stored, pricing goes through the sellers endpoint, where no title matching is
 * involved at all.
 *
 * Because this step resolves by NAME, it is the one place the matching gate
 * still matters. A wrong id here would silently attach another product's whole
 * price list, which is worse than leaving the product unpriced -- so a
 * candidate must clear isSameProduct, and where several do, the highest title
 * score wins.
 *
 * Cost: one request per product, $0.001 on the standard queue.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isSameProduct, isRefinementChip, scoreTitle, searchKeyword } from './lib/product-match.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const INCLUDE_PRICED = args.includes('--include-priced');
const CATEGORY = flag('category', null);
const LIMIT = Number(flag('limit', 50));
const PRIORITY = Number(flag('priority', 1));
const LOCATION = Number(flag('location', 2840));
const LANGUAGE = flag('language', 'en');
const DEPTH = Number(flag('depth', 20));
const CONCURRENCY = Number(flag('concurrency', 8));
const OUT = path.join(ROOT, 'reports', `resolve-ids-${CATEGORY ?? 'all'}.json`);

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const EP = 'https://api.dataforseo.com/v3/merchant/google/products';

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

/** Every published nxt-bargains product, paged. */
async function allProducts() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const q = new URLSearchParams({
      'pagination[page]': String(page), 'pagination[pageSize]': '200', status: 'published',
    });
    q.append('filters[tags][$containsi]', 'nxt-bargains');
    if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
    for (const [i, f] of ['name', 'slug', 'googleProductId'].entries()) q.append(`fields[${i}]`, f);
    q.append('populate[offers][fields][0]', 'price');
    const res = await strapi(`/api/commerce-products?${q}`);
    const batch = res?.data ?? [];
    out.push(...batch);
    if (page >= (res?.meta?.pagination?.pageCount ?? 1) || !batch.length) break;
  }
  return out;
}

/* --------------------------------------------------------------------- main */

if (!DFS_LOGIN || !DFS_PASSWORD) { console.error('DATAFORSEO credentials not set.'); process.exit(1); }

/*
 * Products that already have offers are skipped by default: the point of this
 * script was to unblock pricing, and a priced product did not need it.
 *
 * --include-priced lifts that. A product can be priced and still have no id --
 * it was matched by title through the search pipeline rather than by id -- and
 * without an id it cannot be enriched, because product_info is keyed on it.
 * That is 13 products in this catalogue, all priced, all with no description.
 */
const products = (await allProducts())
  .filter((p) => !p.googleProductId)
  .filter((p) => INCLUDE_PRICED || (p.offers ?? []).length === 0)
  .slice(0, LIMIT);

console.log(`products without an id : ${products.length}`);
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
          // Searched without the storage capacity; still matched on p.name.
          keyword: searchKeyword(p.name), location_code: LOCATION, language_code: LANGUAGE,
          depth: DEPTH, tag: p.slug, priority: PRIORITY,
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
}

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
        if (t?.status_code === 20000) { byTag.set(tag, { items: t.result?.[0]?.items ?? [] }); break; }
        if (t && t.status_code !== 40602) { byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` }); break; }
      }
    } catch (e) { if (!/aborted|timeout|fetch failed|JSON/i.test(String(e.message))) throw e; }
    if (Date.now() > deadline) { byTag.set(tag, { error: 'timed out' }); break; }
    await new Promise((res) => setTimeout(res, 10_000));
  }
  if (++done % 10 === 0 || done === pending.length) process.stdout.write(`  collected ${done}/${pending.length}\r`);
});
process.stdout.write('\n');

const findings = [];
for (const p of products) {
  const got = byTag.get(p.slug);
  if (got?.error) { findings.push({ slug: p.slug, name: p.name, error: got.error, id: null }); continue; }

  // Only candidates that clear the gate; among those, the best title score wins.
  const ranked = (got?.items ?? [])
    .filter((i) => i.title && i.product_id && !isRefinementChip(i.title) && isSameProduct(i.title, p.name))
    .map((i) => ({ i, s: scoreTitle(i.title, p.name) }))
    .sort((a, b) => b.s - a.s);

  findings.push({
    slug: p.slug,
    name: p.name,
    error: null,
    id: ranked[0]?.i.product_id ?? null,
    matchedTitle: ranked[0]?.i.title ?? null,
    score: ranked[0] ? Number(ranked[0].s.toFixed(2)) : null,
    candidates: (got?.items ?? []).length,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));

const resolved = findings.filter((f) => f.id);
for (const f of findings.slice(0, 40)) {
  const status = f.error ? `ERR ${f.error}` : f.id ? `-> ${f.id}  (${f.score})  ${String(f.matchedTitle).slice(0, 40)}` : `no match of ${f.candidates} candidate(s)`;
  console.log(`  ${f.slug.slice(0, 40).padEnd(42)} ${status}`);
}
console.log(`\nresolved ${resolved.length} of ${findings.length}`);
console.log(`report: ${OUT}`);

if (!WRITE) { console.log('\nDry run — nothing written.'); process.exit(0); }

let stored = 0;
for (const f of resolved) {
  const hit = await strapi(`/api/commerce-products?filters[slug][$eq]=${encodeURIComponent(f.slug)}&pagination[pageSize]=1&status=published`);
  const docId = hit?.data?.[0]?.documentId;
  if (!docId) continue;
  await strapi(`/api/commerce-products/${docId}?status=published`, {
    method: 'PUT', body: JSON.stringify({ data: { googleProductId: String(f.id) } }),
  });
  stored += 1;
}
console.log(`stored googleProductId on ${stored} product(s).`);
console.log(`\nNext: node scripts/fetch-offers-sellers.mjs --no-offers-only --priority=1 --write`);
