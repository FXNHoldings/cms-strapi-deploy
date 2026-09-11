/**
 * Give every commerce product and category an explicit site, so belonging to a
 * storefront becomes a relation rather than a string in a JSON array.
 *
 *   node scripts/backfill-site-relations.mjs              # dry run
 *   node scripts/backfill-site-relations.mjs --write
 *   node scripts/backfill-site-relations.mjs --write --only=products
 *
 * Why: three collections leaked another site's rows into bestlooking.skin this
 * week. The filters were all written against `tags`, a free-text JSON array
 * matched with $containsi -- so a wrong tag yields an empty catalogue rather
 * than an error, and a collection with no tag at all (categories, brands) has
 * nothing to filter on. commerce-product.site and commerce-category.sites have
 * existed the whole time and nothing had ever written to them.
 *
 * Products: the site is the tag that matches a commerce-site slug. Tags that
 * match no site are left alone -- `img-pad-50` is an image-processing marker on
 * 4 products, and treating "the first tag" as the site would have filed those
 * under a storefront that does not exist.
 *
 * Categories: these carry no ownership of their own, so a category belongs to
 * the sites whose products actually use it. Derived, not guessed.
 *
 * Re-runnable: rows already pointing at the right site are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'all';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const BASE = (env.STRAPI_INTERNAL_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = env.STRAPI_API_TOKEN;

async function api(p, init = {}) {
  const res = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${p} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.status === 204 ? null : res.json();
}

async function all(pathBase) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const sep = pathBase.includes('?') ? '&' : '?';
    const d = await api(`${pathBase}${sep}pagination[page]=${page}&pagination[pageSize]=100`);
    out.push(...(d.data ?? []));
    if (page >= (d.meta?.pagination?.pageCount ?? 1)) break;
  }
  return out;
}

const sites = await all('/api/commerce-sites?fields[0]=slug&fields[1]=name');
const siteBySlug = new Map(sites.map((s) => [s.slug, s]));
console.log(`sites: ${sites.length}`);

let productSiteBySlug = new Map();

if (ONLY === 'all' || ONLY === 'products') {
  const products = await all('/api/commerce-products?fields[0]=slug&fields[1]=tags&populate[site][fields][0]=slug&populate[categories][fields][0]=slug');
  let assigned = 0, already = 0, unmatched = [];
  for (const p of products) {
    const siteTag = (p.tags ?? []).find((t) => siteBySlug.has(t));
    if (!siteTag) { unmatched.push(p.slug); continue; }
    productSiteBySlug.set(p.slug, siteTag);
    if (p.site?.slug === siteTag) { already += 1; continue; }
    if (WRITE) {
      await api(`/api/commerce-products/${p.documentId}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { site: siteBySlug.get(siteTag).documentId } }),
      });
    }
    assigned += 1;
  }
  console.log(`products: ${products.length} | ${WRITE ? 'assigned' : 'would assign'} ${assigned} | already correct ${already} | no site tag ${unmatched.length}`);
  if (unmatched.length) console.log(`   no site tag: ${unmatched.slice(0, 6).join(', ')}${unmatched.length > 6 ? ' ...' : ''}`);
  // remember category -> sites for the second pass
  global.__catSites = new Map();
  for (const p of products) {
    const siteTag = (p.tags ?? []).find((t) => siteBySlug.has(t));
    if (!siteTag) continue;
    for (const c of p.categories ?? []) {
      if (!global.__catSites.has(c.slug)) global.__catSites.set(c.slug, new Set());
      global.__catSites.get(c.slug).add(siteTag);
    }
  }
}

if (ONLY === 'all' || ONLY === 'categories') {
  const cats = await all('/api/commerce-categories?fields[0]=slug&populate[sites][fields][0]=slug');
  const derived = global.__catSites ?? new Map();
  let updated = 0, already = 0, orphan = [];
  for (const c of cats) {
    const want = [...(derived.get(c.slug) ?? [])].sort();
    if (!want.length) { orphan.push(c.slug); continue; }
    const have = (c.sites ?? []).map((s) => s.slug).sort();
    if (have.join(',') === want.join(',')) { already += 1; continue; }
    if (WRITE) {
      await api(`/api/commerce-categories/${c.documentId}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { sites: want.map((s) => siteBySlug.get(s).documentId) } }),
      });
    }
    updated += 1;
    console.log(`   ${c.slug} -> ${want.join(', ')}`);
  }
  console.log(`categories: ${cats.length} | ${WRITE ? 'updated' : 'would update'} ${updated} | already correct ${already} | no products, left alone ${orphan.length}`);
}

console.log(WRITE ? '\nwritten.' : '\ndry run -- nothing written. Re-run with --write.');
