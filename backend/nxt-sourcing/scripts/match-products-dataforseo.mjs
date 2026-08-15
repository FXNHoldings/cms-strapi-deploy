/**
 * Match the Strapi commerce catalogue against DataForSEO and report how well
 * each product can be linked. READ-ONLY: it never writes to Strapi.
 *
 *   node scripts/match-products-dataforseo.mjs --plan            # no API calls, cost estimate
 *   node scripts/match-products-dataforseo.mjs --limit=10        # cheap sample
 *   node scripts/match-products-dataforseo.mjs                   # everything
 *   node scripts/match-products-dataforseo.mjs --site=nxtsmarthome.com.au
 *
 * The question this answers, before any code depends on DataForSEO: *how much of
 * the catalogue can actually be matched, and how confidently?* Identifier
 * coverage is uneven, so each product is routed by the strongest identifier it
 * carries, and confidence is scored uniformly afterwards.
 *
 *   gpid  -> merchant/google/sellers   exact Google product id, returns sellers
 *   asin  -> merchant/amazon/asin      exact Amazon key, full product detail
 *   gtin  -> merchant/google/products  global trade number, near-exact
 *   mpn   -> merchant/google/products  manufacturer part, usually unique per brand
 *   name  -> merchant/google/products  brand + title, genuinely fuzzy
 *
 * The tier only decides how a candidate was found. Confidence comes from title
 * similarity and brand agreement for every tier, so an exact-identifier match
 * whose title disagrees is still flagged — that is the case that would silently
 * reprice the wrong product forever.
 *
 * Everything runs on the standard queue (priority 1), a third of the price of
 * live mode. Tasks are posted 100 per request and polled together, so the
 * queue's 45-minute ceiling is paid once for the whole run, not per product.
 *
 * Verified against the live API on 13 Aug 2026, where docs and behaviour differ:
 *   - Google Shopping has no live endpoint (/live/advanced returns 40402).
 *   - Amazon needs a locale language code ('en_AU'); a bare 'en' returns 40501
 *     "Invalid Field: 'language_code'", which reads as a wrong field name.
 *   - merchant/google/product_spec is currently unavailable (50304).
 * Measured cost per request, standard queue: amazon/asin $0.0015,
 * google/products $0.001, google/sellers $0.001. Failed tasks are not billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

/* ---------------------------------------------------------------- config -- */

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const has = (n) => args.includes(`--${n}`);

const PLAN_ONLY = has('plan');
const LIMIT = Number(flag('limit', Infinity));
const SITE_FILTER = flag('site', null);
const PRIORITY = Number(flag('priority', 1)); // 1 = standard queue; 2 = ~1min at double cost
const LOCATION_CODE = Number(flag('location', 2036)); // 2036 = Australia
const LANGUAGE_CODE = flag('language', 'en');
const AMAZON_LANGUAGE = flag('amazon-language', 'en_AU');
const POLL_TIMEOUT_MS = Number(flag('timeout', 3000)) * 1000;
const CONCURRENCY = Number(flag('concurrency', 8));
const OUT = flag('out', path.join(ROOT, 'reports', 'dataforseo-match-report.json'));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';

const COST = { 'amazon/asin': 0.0015, 'google/products': 0.001, 'google/sellers': 0.001 };
const ENDPOINTS = {
  'amazon/asin': 'https://api.dataforseo.com/v3/merchant/amazon/asin',
  'google/products': 'https://api.dataforseo.com/v3/merchant/google/products',
  'google/sellers': 'https://api.dataforseo.com/v3/merchant/google/sellers',
};

/* ------------------------------------------------------------- utilities -- */

/**
 * DataForSEO wants `Basic base64(login:password)`. Its dashboard also shows a
 * ready-made base64 blob, which is easy to store as DATAFORSEO_PASSWORD by
 * mistake — encoding that again yields a 401 that reads like a wrong password.
 * If the password itself decodes to `<login>:<something>`, it already is the pair.
 */
function authHeader() {
  const pw = DFS_PASSWORD.trim();
  if (/^[A-Za-z0-9+/=]+$/.test(pw) && pw.length > 16) {
    try {
      const [maybeLogin, ...rest] = Buffer.from(pw, 'base64').toString('utf8').split(':');
      if (rest.length && maybeLogin.includes('@')) return `Basic ${pw}`;
    } catch { /* not base64 after all */ }
  }
  return `Basic ${Buffer.from(`${DFS_LOGIN}:${pw}`).toString('base64')}`;
}

const STOPWORDS = new Set(['the','and','for','with','new','genuine','official','original','free','shipping','au','australia','pack','set','inch','in']);
const tokenise = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((x) => x.length > 1 && !STOPWORDS.has(x));

/** Dice coefficient over token sets — normalises for length, so a short
 *  catalogue name buried inside a long marketplace title is not a perfect match. */
function similarity(a, b) {
  const A = new Set(tokenise(a)); const B = new Set(tokenise(b));
  if (!A.size || !B.size) return 0;
  let shared = 0; for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

function score(product, candidate, tier) {
  const titleSim = similarity(product.name, candidate.title);
  let brandBonus = 0;
  if (product.brand && candidate.brand) {
    const same = tokenise(product.brand).some((t) => tokenise(candidate.brand).includes(t));
    brandBonus = same ? 0.1 : -0.15; // a contradicted brand is evidence against
  }
  const tierBonus = { gpid: 0.3, asin: 0.25, gtin: 0.2, mpn: 0.1, name: 0 }[tier] ?? 0;
  const confidence = Math.max(0, Math.min(1, titleSim + brandBonus + tierBonus));
  // An identifier match whose title contradicts looks authoritative, so it is
  // held out of the top band and surfaced for a human instead.
  const band = titleSim < 0.3
    ? (confidence >= 0.5 ? 'review' : 'low')
    : confidence >= 0.75 ? 'high'
    : confidence >= 0.55 ? 'medium'
    : confidence >= 0.35 ? 'low' : 'none';
  return { confidence: +confidence.toFixed(3), titleSim: +titleSim.toFixed(3), band };
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { await worker(items[i]); } catch { /* recorded per item */ }
    }
  }));
}

/* ------------------------------------------------------------ strapi read -- */

async function readAllProducts() {
  const fields = ['name', 'brand', 'asin', 'gtin', 'mpn', 'sku', 'googleProductId'];
  const all = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ 'pagination[page]': String(page), 'pagination[pageSize]': '100' });
    fields.forEach((f, i) => q.append(`fields[${i}]`, f));
    q.append('populate[site][fields][0]', 'domain');
    if (SITE_FILTER) q.append('filters[site][domain][$eq]', SITE_FILTER);
    const res = await fetch(`${STRAPI_URL}/api/commerce-products?${q}`, {
      headers: STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {},
    });
    if (!res.ok) throw new Error(`Strapi ${res.status} reading commerce-products`);
    const json = await res.json();
    all.push(...(json.data ?? []));
    if (page >= (json.meta?.pagination?.pageCount ?? 1)) break;
  }
  return all;
}

/* ------------------------------------------------------- dataforseo tasks -- */

const calls = {};
const bill = (kind, n = 1) => { calls[kind] = (calls[kind] ?? 0) + n; };

/**
 * Post a batch of tasks and collect their results.
 *
 * Batching is what makes this both affordable and quick: 100 tasks per POST,
 * then every task polled concurrently, so the standard queue's wait is paid
 * once for the whole run rather than once per product.
 */
async function runTasks(kind, payloads) {
  const base = ENDPOINTS[kind];
  const byTag = new Map();

  for (let i = 0; i < payloads.length; i += 100) {
    const batch = payloads.slice(i, i + 100);
    const res = await fetch(`${base}/task_post`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map((b) => ({ ...b.payload, tag: b.tag, priority: PRIORITY }))),
      signal: AbortSignal.timeout(120_000),
    });
    bill(kind, batch.length);
    if (!res.ok) throw new Error(`${kind} task_post HTTP ${res.status}`);
    const json = await res.json();
    for (const t of json.tasks ?? []) {
      const tag = t.data?.tag ?? null;
      if (t.status_code === 20100 && t.id) byTag.set(tag, { id: t.id });
      else byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` });
    }
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const entries = [...byTag.entries()].filter(([, v]) => v.id);
  let done = 0;
  await pool(entries, CONCURRENCY, async ([tag, v]) => {
    for (;;) {
      try {
        const r = await fetch(`${base}/task_get/advanced/${v.id}`, {
          headers: { Authorization: authHeader() },
          signal: AbortSignal.timeout(60_000),
        });
        if (r.ok) {
          const j = await r.json();
          const t = j.tasks?.[0];
          if (t?.status_code === 20000) { byTag.set(tag, { result: t.result?.[0] ?? null }); break; }
          // 40602 = task still in queue; anything else is terminal.
          if (t && t.status_code !== 40602) { byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` }); break; }
        }
      } catch { /* transient — keep retrying until the deadline */ }
      if (Date.now() > deadline) { byTag.set(tag, { error: 'timed out waiting for result' }); break; }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (++done % 25 === 0 || done === entries.length) process.stdout.write(`    collected ${done}/${entries.length}\r`);
  });
  if (entries.length) process.stdout.write('\n');
  return byTag;
}

/* ------------------------------------------------- candidates per endpoint -- */

function candidatesFrom(kind, result) {
  if (!result) return [];

  if (kind === 'amazon/asin') {
    const i = result.items?.find((x) => x?.type === 'amazon_product_info') ?? result.items?.[0];
    return i ? [{
      title: i.title, brand: i.brand ?? i.author ?? null,
      price: i.price_from ?? i.price ?? null, currency: i.currency ?? null,
      url: i.url ?? null, image: i.image_url ?? null, source: 'amazon/asin',
    }] : [];
  }

  if (kind === 'google/sellers') {
    /*
     * The product title lives at the RESULT level. Each item is a *seller*, so
     * item.title is the store name — "JB Hi-Fi", "The Good Guys". Scoring the
     * product against those gives a similarity near zero and sinks every match,
     * which is exactly what happened on the first full run: 0/182, entirely an
     * extraction fault rather than a data one.
     *
     * Prices are on `base_price`; `price` is frequently null even when the
     * seller has one.
     */
    const sellers = (result.items ?? []).filter((s) => s?.title || s?.domain);
    const priceOf = (s) => (typeof s.base_price === 'number' ? s.base_price
      : typeof s.price === 'number' ? s.price : null);
    const priced = sellers.filter((s) => priceOf(s) !== null);
    const best = priced.sort((a, b) => priceOf(a) - priceOf(b))[0] ?? sellers[0] ?? null;
    if (!result.title && !best) return [];
    return [{
      title: result.title ?? null,
      brand: null,
      price: best ? priceOf(best) : null,
      currency: best?.currency ?? null,
      url: result.url ?? best?.url ?? null,
      image: result.image_url ?? null,
      source: 'google/sellers',
      sellerCount: sellers.length,
      cheapestSeller: best?.title ?? best?.domain ?? null,
    }];
  }

  return (result.items ?? []).filter((i) => i?.title).map((i) => ({
    title: i.title, brand: i.brand ?? null,
    price: i.price ?? i.low_price ?? null, currency: i.currency ?? null,
    url: i.url ?? null, image: i.image_url ?? null, source: 'google/products',
  }));
}

/* ------------------------------------------------------------- the tiers -- */

/** One route per product: the strongest identifier it carries. Trying a second
 *  tier costs money and cannot beat an exact id that already agrees. */
function routeFor(p) {
  if (p.googleProductId) {
    return { tier: 'gpid', kind: 'google/sellers', payload: { product_id: String(p.googleProductId), location_code: LOCATION_CODE, language_code: LANGUAGE_CODE } };
  }
  if (p.asin) {
    return { tier: 'asin', kind: 'amazon/asin', payload: { asin: p.asin, location_code: LOCATION_CODE, language_code: AMAZON_LANGUAGE } };
  }
  const tier = p.gtin ? 'gtin' : p.mpn ? 'mpn' : 'name';
  const keyword = p.gtin ? p.gtin
    : p.mpn ? [p.brand, p.mpn].filter(Boolean).join(' ')
    : [p.brand, p.name].filter(Boolean).join(' ');
  return { tier, kind: 'google/products', payload: { keyword, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE, depth: 10 } };
}

/* ------------------------------------------------------------------ main -- */

const products = (await readAllProducts()).slice(0, LIMIT);
const routes = products.map((p) => ({ product: p, ...routeFor(p), tag: `p${p.id}` }));
const byKind = routes.reduce((acc, r) => ((acc[r.kind] ??= []).push(r), acc), {});
const multiplier = PRIORITY === 2 ? 2 : 1;
const estimate = Object.entries(byKind).reduce((s, [k, v]) => s + v.length * COST[k] * multiplier, 0);

console.log(`source   : ${STRAPI_URL} (commerce-products, read-only)${SITE_FILTER ? ` [site=${SITE_FILTER}]` : ''}`);
console.log(`products : ${products.length}`);
for (const [tier, n] of Object.entries(routes.reduce((a, r) => ((a[r.tier] = (a[r.tier] ?? 0) + 1), a), {}))) {
  console.log(`  ${tier.padEnd(5)} : ${n}`);
}
console.log(`queue    : priority ${PRIORITY} (${PRIORITY === 1 ? 'standard, <=45min' : 'priority, ~1min'})`);
console.log(`estimate : $${estimate.toFixed(2)}\n`);

if (PLAN_ONLY) { console.log('--plan: no API calls made.'); process.exit(0); }
if (!DFS_LOGIN || !DFS_PASSWORD) { console.error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set.'); process.exit(1); }

const started = Date.now();
const results = [];

for (const [kind, group] of Object.entries(byKind)) {
  console.log(`${kind}: ${group.length} task(s)`);
  const out = await runTasks(kind, group.map((g) => ({ payload: g.payload, tag: g.tag })));
  for (const g of group) {
    const r = out.get(g.tag) ?? { error: 'no response for tag' };
    const cands = r.error ? [] : candidatesFrom(kind, r.result);
    const best = cands
      .map((c) => ({ candidate: c, ...score(g.product, c, g.tier) }))
      .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
    results.push({
      id: g.product.id, documentId: g.product.documentId, name: g.product.name,
      brand: g.product.brand ?? null, site: g.product.site?.domain ?? null,
      identifiers: {
        googleProductId: g.product.googleProductId ?? null, asin: g.product.asin ?? null,
        gtin: g.product.gtin ?? null, mpn: g.product.mpn ?? null,
      },
      matchedVia: g.tier, endpoint: kind,
      band: best?.band ?? 'none', confidence: best?.confidence ?? 0,
      titleSimilarity: best?.titleSim ?? 0, matched: best?.candidate ?? null,
      candidates: cands.length, error: r.error ?? null,
    });
  }
}

const bands = results.reduce((a, r) => ((a[r.band] = (a[r.band] ?? 0) + 1), a), {});
const spend = Object.entries(calls).reduce((s, [k, n]) => s + n * COST[k] * multiplier, 0);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({
  generatedAt: new Date().toISOString(), strapiUrl: STRAPI_URL, siteFilter: SITE_FILTER,
  priority: PRIORITY, locationCode: LOCATION_CODE, calls,
  estimatedCostUsd: +spend.toFixed(3), bands, results,
}, null, 2)}\n`);

console.log('\nmatch confidence');
for (const b of ['high', 'medium', 'review', 'low', 'none']) {
  const n = bands[b] ?? 0;
  console.log(`  ${b.padEnd(7)} ${String(n).padStart(4)}  ${((n / results.length) * 100).toFixed(1).padStart(5)}%`);
}
console.log('\nby tier (high or medium)');
for (const t of ['gpid', 'asin', 'gtin', 'mpn', 'name']) {
  const all = results.filter((r) => r.matchedVia === t);
  if (!all.length) continue;
  const ok = all.filter((r) => r.band === 'high' || r.band === 'medium').length;
  console.log(`  ${t.padEnd(5)} ${String(ok).padStart(4)}/${String(all.length).padEnd(4)} ${((ok / all.length) * 100).toFixed(0)}%`);
}
console.log(`\ncalls    : ${JSON.stringify(calls)}`);
console.log(`spend    : $${spend.toFixed(2)}`);
console.log(`errors   : ${results.filter((r) => r.error).length}`);
console.log(`elapsed  : ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`report   : ${OUT}`);
console.log('\nNothing was written to Strapi.');

const review = results.filter((r) => r.band === 'review');
if (review.length) {
  console.log(`\n${review.length} matched an identifier but the title disagrees — check these first:`);
  for (const r of review.slice(0, 10)) {
    console.log(`  [${r.matchedVia}] ${r.name}`);
    console.log(`      -> ${r.matched?.title ?? '(none)'} (similarity ${r.titleSimilarity})`);
  }
}
