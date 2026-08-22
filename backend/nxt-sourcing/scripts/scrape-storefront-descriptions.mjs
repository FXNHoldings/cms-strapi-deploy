/**
 * Fill in missing product descriptions from the storefront pages we already
 * link to.
 *
 *   node scripts/scrape-storefront-descriptions.mjs                 # dry run
 *   node scripts/scrape-storefront-descriptions.mjs --write
 *   ... --limit=20  --slug=<one>  --min-length=120  --delay=1500
 *
 * Why here rather than Amazon: none of the products missing a description have
 * an Amazon offer or an ASIN, so an Amazon lookup would first have to *find* the
 * product by title -- the same fuzzy match that previously attached a phone
 * case's brand and a carrier's instalment price to real products. The stored
 * productUrl points at exactly the variant we priced, so there is no matching
 * risk at all.
 *
 * Extraction order, best first:
 *
 *   1. JSON-LD Product.description   real product copy, several sentences
 *   2. og:description                usually the same copy, sometimes truncated
 *   3. twitter:description
 *   4. <meta name="description">     often a page template, so gated hardest
 *
 * Everything is gated before it is written. A retailer's meta description is
 * frequently boilerplate ("Free shipping on orders over $35") or a site-wide
 * tagline, and storing that would be worse than the blank we started with --
 * it reads as real content while telling the reader nothing. So a candidate has
 * to be long enough, has to mention something from the product's own name, and
 * has to survive a boilerplate blacklist.
 *
 * Politeness: one request at a time per host with a delay between them, so a
 * retailer sees a slow trickle rather than a burst. Hosts that answer 403 are
 * dropped for the rest of the run instead of being retried into a hard block.
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
const SLUG = flag('slug', null);
const LIMIT = Number(flag('limit', Infinity));
const MIN_LENGTH = Number(flag('min-length', 100));
const DELAY_MS = Number(flag('delay', 1500));
const HOST_CONCURRENCY = Number(flag('hosts', 6));
const SITE_TAG = flag('site-tag', 'nxt-bargains');
const OUT = path.join(ROOT, 'reports', 'storefront-descriptions.json');

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/*
 * Phrases that mean a page template rather than this product. Matched against
 * the whole candidate, lowercased.
 */
const BOILERPLATE = [
  /*
   * These two were found the hard way. Newegg's og:description is
   * "Search Newegg.com for <full product name>. Get fast shipping and
   * top-rated customer service." -- it repeats the product name in full, so it
   * sails through a name-overlap check while saying nothing about the product.
   * Any rule based on "does it mention the product" is defeated by a template
   * that interpolates the product; the phrasing has to be blacklisted directly.
   */
  'get fast shipping and top-rated customer service',
  'search newegg.com for',
  'free shipping on orders',
  'shop for ',
  'buy online, pick up',
  'save money. live better',
  'find great deals',
  'we offer fast, reliable delivery',
  'sign in for the best experience',
  'enable javascript',
  'your browser is not supported',
  'access denied',
  'robot or human',
  'are you a human',
  'page not found',
];

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

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function clean(s) {
  return decodeEntities(String(s ?? '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Candidate descriptions found in a page, best source first. */
function extractCandidates(html) {
  const out = [];

  // 1. JSON-LD Product.description
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (node['@graph']) stack.push(...[].concat(node['@graph']));
      const type = [].concat(node['@type'] ?? []).join(' ').toLowerCase();
      if (type.includes('product') && node.description) out.push({ src: 'json-ld', text: clean(node.description) });
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
  }

  const meta = (re, src) => {
    const m = html.match(re);
    if (m?.[1]) out.push({ src, text: clean(m[1]) });
  };
  meta(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i, 'og');
  meta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i, 'og');
  meta(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i, 'twitter');
  meta(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i, 'meta');

  return out;
}

/** Words from the product name worth requiring in a description. */
function significantTokens(name) {
  return String(name).toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g)?.filter((t) => t.length > 2) ?? [];
}

/**
 * Is this candidate actually about this product?
 *
 * The length floor alone lets through a retailer's category blurb, so the text
 * also has to echo the product: at least two words from its name, or one plus
 * the brand. Anything shorter than the floor, or on the boilerplate list, is
 * discarded no matter where it came from.
 */
function accept(text, productName, minLength) {
  if (!text || text.length < minLength) return { ok: false, why: `too short (${text?.length ?? 0})` };
  const low = text.toLowerCase();
  for (const b of BOILERPLATE) if (low.includes(b)) return { ok: false, why: `boilerplate: "${b}"` };

  const tokens = significantTokens(productName);
  const hits = tokens.filter((t) => low.includes(t)).length;
  if (hits < 2) return { ok: false, why: `only ${hits} of ${tokens.length} name tokens present` };
  return { ok: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------- main */

async function allProducts() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const q = new URLSearchParams({
      'pagination[page]': String(page), 'pagination[pageSize]': '200', status: 'published',
    });
    q.append('filters[tags][$containsi]', SITE_TAG);
    if (SLUG) q.append('filters[slug][$eq]', SLUG);
    for (const [i, f] of ['name', 'slug', 'description'].entries()) q.append(`fields[${i}]`, f);
    q.append('populate[offers][fields][0]', 'productUrl');
    q.append('populate[offers][populate][merchant][fields][0]', 'name');
    const res = await strapi(`/api/commerce-products?${q}`);
    const batch = res?.data ?? [];
    out.push(...batch);
    if (page >= (res?.meta?.pagination?.pageCount ?? 1) || !batch.length) break;
  }
  return out;
}

const products = (await allProducts())
  .filter((p) => !String(p.description ?? '').replace(/<[^>]*>/g, '').trim())
  .map((p) => {
    const urls = [...new Set((p.offers ?? [])
      .map((o) => o.productUrl)
      .filter((u) => /^https?:\/\//i.test(u ?? '')))];
    return { ...p, urls };
  })
  .filter((p) => p.urls.length)
  .slice(0, LIMIT);

console.log(`products with no description and a storefront url : ${products.length}`);
console.log(`mode : ${WRITE ? 'WRITE' : 'DRY RUN'}   min-length ${MIN_LENGTH}   delay ${DELAY_MS}ms\n`);
if (!products.length) process.exit(0);

/*
 * Group the work by host so each retailer is hit by exactly one worker, in
 * sequence, with a delay. A product appears under every host it has a URL for;
 * once one host yields a description the rest are skipped.
 */
const byHost = new Map();
for (const p of products) {
  for (const url of p.urls) {
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push({ product: p, url });
  }
}

const found = new Map();     // slug -> { text, src, host }
const blocked = new Set();   // hosts that answered 403/429
const stats = { fetched: 0, ok: 0, rejected: 0, http: 0 };

const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length);
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, hosts.length) }, async () => {
  while (cursor < hosts.length) {
    const [host, jobs] = hosts[cursor++];
    for (const { product, url } of jobs) {
      if (found.has(product.slug)) continue;
      if (blocked.has(host)) break;

      let html = null;
      try {
        const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        stats.fetched += 1;
        if (res.status === 403 || res.status === 429) {
          blocked.add(host);
          console.log(`  ${host} -> HTTP ${res.status}, skipping this host for the rest of the run`);
          break;
        }
        if (!res.ok) { stats.http += 1; await sleep(DELAY_MS); continue; }
        html = await res.text();
      } catch {
        stats.http += 1;
        await sleep(DELAY_MS);
        continue;
      }

      for (const cand of extractCandidates(html)) {
        const verdict = accept(cand.text, product.name, MIN_LENGTH);
        if (verdict.ok) {
          found.set(product.slug, { text: cand.text, src: cand.src, host });
          stats.ok += 1;
          break;
        }
        stats.rejected += 1;
      }
      await sleep(DELAY_MS);
    }
  }
}));

const results = products.map((p) => ({
  slug: p.slug,
  name: p.name,
  ...(found.get(p.slug) ?? { text: null, src: null, host: null }),
}));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

const hits = results.filter((r) => r.text);
console.log(`\n  pages fetched     : ${stats.fetched}`);
console.log(`  hosts blocked     : ${blocked.size}${blocked.size ? ` (${[...blocked].join(', ')})` : ''}`);
console.log(`  candidates rejected: ${stats.rejected}`);
console.log(`  DESCRIPTIONS FOUND: ${hits.length} of ${products.length}`);

const bySrc = {};
for (const h of hits) bySrc[`${h.src} @ ${h.host}`] = (bySrc[`${h.src} @ ${h.host}`] ?? 0) + 1;
for (const [k, v] of Object.entries(bySrc).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${k.padEnd(34)} ${v}`);

console.log('\n  samples:');
for (const h of hits.slice(0, 3)) console.log(`    ${h.slug}\n      [${h.src}] ${h.text.slice(0, 150)}...`);
console.log(`\n  report: ${OUT}`);

if (!WRITE) { console.log('\nDry run — nothing written.'); process.exit(0); }

let stored = 0;
for (const h of hits) {
  const hit = await strapi(`/api/commerce-products?filters[slug][$eq]=${encodeURIComponent(h.slug)}&pagination[pageSize]=1&status=published`);
  const docId = hit?.data?.[0]?.documentId;
  if (!docId) continue;
  await strapi(`/api/commerce-products/${docId}?status=published`, {
    method: 'PUT', body: JSON.stringify({ data: { description: h.text } }),
  });
  stored += 1;
}
console.log(`stored a description on ${stored} product(s).`);
