/**
 * Fill in the parts of a product that Google Shopping search does not carry:
 * description, features, specifications, images and a real storefront URL.
 *
 *   node scripts/enrich-products-product-info.mjs --category=smart-phones
 *   node scripts/enrich-products-product-info.mjs --category=smart-phones --write
 *   ... --slug=<one-product>   --limit=10   --no-image
 *
 * merchant/google/product_info, keyed on the googleProductId already stored by
 * the sourcing pipeline. It returns markedly more than the search endpoint:
 *
 *   description     prose, several sentences
 *   specifications  name/value pairs
 *   images          several, not the single search thumbnail
 *   url + sellers   REAL storefront links and a regular price (the RRP)
 *
 * That last one matters most. The search endpoint returns `url: null` and
 * `domain: null` on every item, so offers created from it can only link to a
 * retailer search page. product_info gives the actual product URL, which is what
 * an affiliate link has to wrap.
 *
 * The feature image is uploaded into Strapi's media library rather than
 * hot-linked. Google's `encrypted-tbn*.gstatic.com` thumbnails are short-lived
 * and rate-limited, so a page built on them degrades to broken images.
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
const NO_IMAGE = args.includes('--no-image');
const CATEGORY = flag('category', null);
const SLUG = flag('slug', null);
const SLUGS_FILE = flag('slugs-file', null);
/* Every product this catalogue owns carries this tag; see selectProducts(). */
const SITE_TAG = flag('site-tag', 'nxt-bargains');
const LIMIT = Number(flag('limit', Infinity));
const PRIORITY = Number(flag('priority', 2));
const LOCATION = Number(flag('location', 2840));
const LANGUAGE = flag('language', 'en');
const CONCURRENCY = Number(flag('concurrency', 8));
const OUT = path.join(ROOT, 'reports', `enrich-${CATEGORY ?? SLUG ?? 'all'}.json`);

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const EP = 'https://api.dataforseo.com/v3/merchant/google/product_info';

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
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/* --------------------------------------------------------------------- main */

if (!CATEGORY && !SLUG && !SLUGS_FILE) {
  console.error('usage: --category=<slug> | --slug=<product> | --slugs-file=<path> [--write]');
  process.exit(1);
}

/*
 * The selection is paginated and tag-scoped, neither of which it used to be.
 *
 * A single pageSize=200 request silently truncated any category larger than
 * that -- Smart Phones is over it -- so the tail of the category was never
 * enriched and never reported as missing. And filtering by category alone
 * crosses sites: commerce-categories is a shared taxonomy, so "Smart Phones"
 * also matches products belonging to other storefronts. Enriching those would
 * spend money writing to another site's catalogue.
 */
const wanted = SLUGS_FILE
  ? new Set(fs.readFileSync(SLUGS_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))
  : null;

async function selectProducts() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const q = new URLSearchParams({
      'pagination[page]': String(page), 'pagination[pageSize]': '200', status: 'published',
    });
    /* The site tag is how a run says "everything for this property". When the
       caller has instead named products explicitly — one slug, or a file of
       them — that gate is redundant and actively wrong: the nxtsmarthome
       catalogue carries category tags rather than a site tag, so with the gate
       always on, 363 offers stuck on search URLs could never be reached by any
       invocation. */
    if (!SLUG && !SLUGS_FILE) q.append('filters[tags][$containsi]', SITE_TAG);
    if (SLUG) q.append('filters[slug][$eq]', SLUG);
    if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
    for (const [i, f] of ['name', 'slug', 'googleProductId', 'description'].entries()) q.append(`fields[${i}]`, f);
    q.append('populate[primaryImage][fields][0]', 'url');

    const res = await strapi(`/api/commerce-products?${q}`);
    const batch = res?.data ?? [];
    out.push(...batch);
    if (page >= (res?.meta?.pagination?.pageCount ?? 1) || !batch.length) break;
  }
  return wanted ? out.filter((p) => wanted.has(p.slug)) : out;
}

const list = { data: await selectProducts() };
const products = (list?.data ?? []).filter((p) => p.googleProductId).slice(0, LIMIT);
const skipped = (list?.data ?? []).length - products.length;

console.log(`products : ${products.length}${skipped > 0 ? ` (${skipped} without a googleProductId, skipped)` : ''}`);
console.log(`estimate : $${(products.length * 0.001 * (PRIORITY === 2 ? 2 : 1)).toFixed(3)}`);
console.log(`mode     : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);
if (!products.length) process.exit(0);

/* ---- fetch product_info for each ---- */

console.log('fetching product_info ...');
const byTag = new Map();
for (let i = 0; i < products.length; i += 100) {
  const batch = products.slice(i, i + 100);
  // The API occasionally stalls past two minutes on task_post. Retrying is safe
  // — a timed-out post either created nothing or created tasks we re-post.
  let res = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      res = await fetch(`${EP}/task_post`, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map((p) => ({
          product_id: p.googleProductId, location_code: LOCATION, language_code: LANGUAGE,
          tag: p.slug, priority: PRIORITY,
        }))),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) break;
      console.log(`   task_post HTTP ${res.status}, retry ${attempt}/4`);
    } catch (e) {
      console.log(`   task_post ${e.name ?? e.message}, retry ${attempt}/4`);
    }
    res = null;
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  if (!res || !res.ok) throw new Error('task_post failed after 4 attempts');
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
      const r = await fetch(`${EP}/task_get/advanced/${v.id}`, {
        headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(90_000),
      });
      const text = await r.text();
      if (r.ok && text.trim().startsWith('{')) {
        const t = JSON.parse(text).tasks?.[0];
        if (t?.status_code === 20000) { byTag.set(tag, { item: t.result?.[0]?.items?.[0] ?? null }); break; }
        if (t && t.status_code !== 40602) { byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` }); break; }
      }
    } catch (e) { if (!/aborted|timeout|fetch failed|JSON/i.test(String(e.message))) throw e; }
    if (Date.now() > deadline) { byTag.set(tag, { error: 'timed out' }); break; }
    await new Promise((res) => setTimeout(res, 10_000));
  }
  if (++done % 5 === 0 || done === pending.length) process.stdout.write(`    ${done}/${pending.length}\r`);
});
if (pending.length) process.stdout.write('\n');

/* ---- shape it ---- */

const findings = [];
for (const p of products) {
  const got = byTag.get(p.slug);
  const it = got?.item ?? null;
  const specs = {};
  for (const s of it?.specifications ?? []) {
    if (!s?.specification_name || !s?.specification_value) continue;
    specs[String(s.specification_name).trim()] = String(s.specification_value).trim();
  }
  const features = Array.isArray(it?.features)
    ? it.features.map((f) => String(f).trim()).filter(Boolean)
    : [];
  findings.push({
    slug: p.slug,
    name: p.name,
    error: got?.error ?? null,
    description: it?.description ?? null,
    specs,
    specCount: Object.keys(specs).length,
    features,
    images: (it?.images ?? []).filter(Boolean),
    url: it?.url ?? null,
    hadImage: Boolean(p.primaryImage),
    // A seller's `regular` price is the RRP the search endpoint almost never had.
    sellers: (it?.sellers ?? []).map((s) => ({
      title: s.title, url: s.url,
      price: s.price?.current ?? null,
      regular: s.price?.regular ?? null,
    })).filter((s) => s.title),
  });
}

fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));

for (const f of findings) {
  const bits = [
    f.description ? `desc ${f.description.length}ch` : 'desc -',
    `specs ${f.specCount}`,
    `features ${f.features.length}`,
    `images ${f.images.length}`,
    f.url ? 'url yes' : 'url -',
    `sellers ${f.sellers.length}`,
  ];
  console.log(`  ${f.slug.slice(0, 44).padEnd(46)} ${bits.join('  ')}${f.error ? `  ERR ${f.error}` : ''}`);
}
console.log(`\nreport: ${OUT}`);

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write.'); process.exit(0); }

/* -------------------------------------------------------------- write ---- */

/** Pull an image and put it in Strapi's media library, returning its id. */
async function uploadImage(url, name) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? 'image/jpeg';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`image too small (${buf.length}b)`);
  const form = new FormData();
  form.append('files', new Blob([buf], { type }), `${name}.${ext}`);
  const up = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form,
  });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 120)}`);
  return (await up.json())[0]?.id ?? null;
}

let updated = 0, imaged = 0, urlsFixed = 0, imgErrors = 0;
for (const f of findings) {
  if (f.error) continue;
  const data = {};
  if (f.description) data.description = f.description;
  if (f.specCount || f.features.length) {
    data.specs = {
      ...f.specs,
      ...(f.features.length ? { features: f.features } : {}),
      source: 'dataforseo-product-info',
      importedAt: new Date().toISOString(),
      ...(f.images[0] ? { sourceImageUrl: f.images[0] } : {}),
    };
  }
  if (f.images[0]) data.imageUrl = f.images[0];

  if (!NO_IMAGE && f.images[0] && !f.hadImage) {
    try {
      const id = await uploadImage(f.images[0], f.slug);
      if (id) { data.primaryImage = id; imaged += 1; }
    } catch (e) {
      imgErrors += 1;
      console.log(`   ! image failed for ${f.slug}: ${e.message}`);
    }
  }

  if (Object.keys(data).length) {
    const hit = await strapi(`/api/commerce-products?filters[slug][$eq]=${encodeURIComponent(f.slug)}&pagination[pageSize]=1&status=published`);
    const docId = hit?.data?.[0]?.documentId;
    if (docId) {
      await strapi(`/api/commerce-products/${docId}?status=published`, { method: 'PUT', body: JSON.stringify({ data }) });
      updated += 1;
    }
  }

  /*
   * Offers created from the search endpoint point at a retailer search page,
   * because that endpoint has no storefront URL. Now that a real one exists,
   * replace it — an affiliate link can only wrap a genuine product URL.
   */
  // Fetched once, not once per seller: the list is the same every time round.
  const offers = f.sellers.some((s) => s.url && s.title)
    ? (await strapi(`/api/commerce-offers?filters[product][slug][$eq]=${encodeURIComponent(f.slug)}&populate[merchant][fields][0]=name&pagination[pageSize]=50&status=published`))?.data ?? []
    : [];

  const claimed = new Set();
  for (const s of f.sellers) {
    if (!s.url || !s.title) continue;
    for (const o of offers) {
      if (claimed.has(o.documentId)) continue;
      if (!merchantMatchesSeller(o.merchant?.name, s.title)) continue;
      if (o.productUrl && !o.productUrl.includes('/search') && !o.productUrl.includes('?q=')) continue;
      await strapi(`/api/commerce-offers/${o.documentId}?status=published`, {
        method: 'PUT',
        body: JSON.stringify({ data: { productUrl: s.url, ...(s.regular ? { originalPrice: s.regular } : {}) } }),
      });
      claimed.add(o.documentId);
      urlsFixed += 1;
      break;
    }
  }
}

/**
 * Does this DataForSEO seller correspond to one of our merchants?
 *
 * The old test asked whether the seller's title contained the merchant name's
 * first word. For a domain-style name that "word" is the whole domain —
 * "mercari.com" — which no seller title ever contains, so all 110 of that
 * merchant's offers were permanently unfixable. Strip the suffix, compare in
 * both directions, and only fall back to a first-word match when that word is
 * long enough to mean something.
 */
function merchantMatchesSeller(merchantName, sellerTitle) {
  const norm = (v) =>
    String(v ?? '')
      .toLowerCase()
      .replace(/\.(com\.au|co\.uk|com|au|net|org)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const m = norm(merchantName);
  const t = norm(sellerTitle);
  if (!m || !t) return false;
  if (t.includes(m) || m.includes(t)) return true;

  const first = m.split(' ')[0];
  return first.length >= 3 && t.includes(first);
}

console.log(`\nupdated ${updated} products, uploaded ${imaged} feature images, replaced ${urlsFixed} placeholder offer URLs.`);
if (imgErrors) console.log(`${imgErrors} image(s) could not be fetched.`);
