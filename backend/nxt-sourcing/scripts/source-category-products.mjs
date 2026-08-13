/**
 * Source a category's products from DataForSEO Google Shopping. READ-ONLY
 * unless --write is passed.
 *
 *   node scripts/source-category-products.mjs --category="Smart Phones"
 *   node scripts/source-category-products.mjs --all --depth=50
 *   node scripts/source-category-products.mjs --all --write
 *
 * Product-first sourcing, which is the point. The existing catalogue was built
 * by searching each merchant separately for a product name and hoping the top
 * hit was the same item — that is where the mismatches come from
 * (amazon-product-info2 6.0%, impact-catalog-api 4.8%, against 0% for a
 * curated import). Here a single Google Shopping query returns real products,
 * each with a `product_id`, and offers are fetched later *for that id*. Nothing
 * is matched by keyword, so there is nothing to mismatch.
 *
 * The product_id is stored as googleProductId, which makes every later
 * repricing run an exact lookup rather than a fresh guess.
 *
 * Costs, measured: google/products standard queue $0.001 per query. One query
 * per category returns up to `depth` products, so sourcing 13 categories at 50
 * products each costs about a cent.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const has = (n) => args.includes(`--${n}`);

const CATEGORY = flag('category', null);
const ALL = has('all');
const DEPTH = Number(flag('depth', 50));
const PRIORITY = Number(flag('priority', 1));
const LOCATION = Number(flag('location', 2840));   // 2840 = United States
const LANGUAGE = flag('language', 'en');
const OUT = flag('out', path.join(ROOT, 'reports', 'sourced-categories.json'));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';

const POST = 'https://api.dataforseo.com/v3/merchant/google/products/task_post';
const GET = 'https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced';

/** DataForSEO's dashboard shows a ready-made base64 blob that is easy to store
 *  as the password; encoding it again gives a 401 that reads like a bad key. */
function authHeader() {
  const pw = DFS_PASSWORD.trim();
  if (/^[A-Za-z0-9+/=]+$/.test(pw) && pw.length > 16) {
    try {
      const [maybeLogin, ...rest] = Buffer.from(pw, 'base64').toString('utf8').split(':');
      if (rest.length && maybeLogin.includes('@')) return `Basic ${pw}`;
    } catch { /* not base64 */ }
  }
  return `Basic ${Buffer.from(`${DFS_LOGIN}:${pw}`).toString('base64')}`;
}

async function strapi(pathname) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    headers: STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`Strapi ${res.status} on ${pathname}`);
  return res.json();
}

/** Categories currently used by the nxt-bargains catalogue. */
async function readCategories() {
  const json = await strapi('/api/commerce-categories?pagination[pageSize]=100&fields[0]=name&fields[1]=slug');
  return (json.data ?? []).map((c) => ({ name: c.name, slug: c.slug }));
}

async function sourceCategory(category) {
  const post = await fetch(POST, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      keyword: category.name,
      location_code: LOCATION,
      language_code: LANGUAGE,
      depth: DEPTH,
      priority: PRIORITY,
      tag: category.slug,
    }]),
    signal: AbortSignal.timeout(120_000),
  });
  if (!post.ok) throw new Error(`task_post HTTP ${post.status}`);
  const posted = await post.json();
  const task = posted.tasks?.[0];
  if (task?.status_code !== 20100 || !task.id) throw new Error(`${task?.status_code}: ${task?.status_message}`);

  const deadline = Date.now() + 45 * 60 * 1000;
  for (;;) {
    // A slow or dropped poll must not discard a task that has already been paid
    // for — transient failures are retried until the deadline, and only a
    // terminal task status ends the loop.
    try {
      const r = await fetch(`${GET}/${task.id}`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) {
        const j = await r.json();
        const t = j.tasks?.[0];
        if (t?.status_code === 20000) return t.result?.[0] ?? null;
        if (t && t.status_code !== 40602) throw new Error(`${t.status_code}: ${t.status_message}`); // 40602 = queued
      }
    } catch (err) {
      if (!/aborted|timeout|fetch failed|network/i.test(String(err.message))) throw err;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for result');
    await new Promise((res) => setTimeout(res, 10_000));
  }
}

/** Listing noise that is not a product we would ever stock. */
const REJECT = [
  'refurbished', 'renewed', 'restored', 'pre-owned', 'preowned', 'open box',
  'for parts', 'parts only', 'case', 'screen protector', 'charger only',
];

function shape(result, category) {
  const items = (result?.items ?? []).filter((i) => i?.title);
  const out = [];
  const seen = new Set();
  for (const i of items) {
    const title = String(i.title).trim();
    const low = title.toLowerCase();
    if (REJECT.some((r) => low.includes(r))) continue;
    // product_id is the whole point: without it there is no exact identifier
    // and the product is no better than the keyword-matched ones we are replacing.
    if (!i.product_id) continue;
    if (seen.has(i.product_id)) continue;
    seen.add(i.product_id);
    out.push({
      googleProductId: String(i.product_id),
      name: title,
      brand: i.brand ?? null,
      price: typeof i.price === 'number' ? i.price : (i.low_price ?? null),
      currency: i.currency ?? 'USD',
      imageUrl: i.image_url ?? null,
      seller: i.seller ?? i.domain ?? null,
      rating: i.rating?.value ?? null,
      ratingCount: i.rating?.votes_count ?? null,
      category: category.name,
      categorySlug: category.slug,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ main -- */

if (!DFS_LOGIN || !DFS_PASSWORD) {
  console.error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set.');
  process.exit(1);
}

const all = await readCategories();
const targets = ALL ? all : all.filter((c) => c.name === CATEGORY || c.slug === CATEGORY);
if (!targets.length) {
  console.error(`No category matched ${CATEGORY ?? '(none given)'}. Available:\n  ${all.map((c) => c.name).join('\n  ')}`);
  process.exit(1);
}

console.log(`categories : ${targets.length}`);
console.log(`depth      : ${DEPTH} per category`);
console.log(`location   : ${LOCATION} (${LANGUAGE})`);
console.log(`estimate   : $${(targets.length * 0.001 * (PRIORITY === 2 ? 2 : 1)).toFixed(3)}\n`);

const sourced = [];
for (const c of targets) {
  process.stdout.write(`  ${c.name} ... `);
  try {
    const result = await sourceCategory(c);
    const products = shape(result, c);
    sourced.push({ category: c, products });
    console.log(`${products.length} products`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    sourced.push({ category: c, products: [], error: err.message });
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), location: LOCATION, depth: DEPTH, sourced }, null, 2)}\n`);

const total = sourced.reduce((n, s) => n + s.products.length, 0);
console.log(`\ntotal products sourced: ${total}`);
console.log(`report: ${OUT}`);
console.log('\nRead-only: nothing was written to Strapi.');
