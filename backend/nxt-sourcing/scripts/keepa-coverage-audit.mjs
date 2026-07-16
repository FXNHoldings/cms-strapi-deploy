#!/usr/bin/env node
/**
 * Keepa coverage audit — decide whether a Keepa API subscription is worth it
 * for this catalog *before* paying for it.
 *
 * Two layers:
 *   LAYER 1 (no Keepa key needed): how much of the catalog is even on Amazon?
 *     Keepa is Amazon-only, so this is the ceiling on what Keepa could ever help
 *     with. Reports total products, products with >=1 Amazon offer (= Keepa-
 *     addressable), unique ASINs, and the merchant distribution.
 *   LAYER 2 (needs KEEPA_API_KEY): for each Amazon ASIN, query Keepa and measure
 *     real history depth (days of history, # price points, lifetime low) so you
 *     can see how rich the backfill would actually be.
 *
 * Usage:
 *   node scripts/keepa-coverage-audit.mjs            # Layer 1 only
 *   KEEPA_API_KEY=xxx node scripts/keepa-coverage-audit.mjs   # + Layer 2
 *   KEEPA_API_KEY=xxx node scripts/keepa-coverage-audit.mjs --limit 50
 *
 * Keepa tokens: ~1 token per ASIN (history, no offers). The script batches up to
 * 100 ASINs per request and prints tokens left/consumed so you don't overspend
 * on a trial key. --limit caps how many ASINs are sent to Keepa.
 */
import { readFileSync } from 'node:fs';

const ENV = (() => {
  try { return readFileSync(new URL('../.env.local', import.meta.url), 'utf8'); }
  catch { return ''; }
})();
const get = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || process.env[k] || '').trim();

const BASE = (get('STRAPI_URL') || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const TOKEN = get('STRAPI_API_TOKEN');
const KEEPA_KEY = get('KEEPA_API_KEY');
const KEEPA_DOMAIN = get('KEEPA_DOMAIN') || '1'; // 1 = amazon.com

const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();

const ASIN_RE = /^[A-Z0-9]{10}$/;
function extractAsin(offer) {
  const sku = String(offer.merchantSku || '').trim().toUpperCase();
  if (ASIN_RE.test(sku)) return sku;
  for (const url of [offer.productUrl, offer.affiliateUrl]) {
    const m = String(url || '').match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// ---------- Strapi: pull the full catalog ----------
async function fetchAllProducts() {
  const all = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'fields[0]': 'name',
      'fields[1]': 'slug',
      'fields[2]': 'asin',
      'populate[offers][populate][0]': 'merchant',
    });
    const res = await fetch(`${BASE}/api/commerce-products?${params}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`Strapi product list failed: HTTP ${res.status}`);
    const json = await res.json();
    all.push(...(json.data || []));
    const pc = json?.meta?.pagination?.pageCount ?? 1;
    if (page >= pc) break;
    page += 1;
  }
  return all;
}

// ---------- Keepa: history depth per ASIN ----------
const KEEPA_EPOCH_MIN = 21564000; // keepaMinutes -> unix: (min + offset) * 60000
function keepaTimeToDate(min) {
  return new Date((min + KEEPA_EPOCH_MIN) * 60000);
}
// csv[0] = Amazon price, csv[1] = marketplace New. Format: [time, value, time, value, ...]
// value is in cents; -1 = no data at that point.
function analyseCsv(csv) {
  const series = [csv?.[0], csv?.[1]].filter(Array.isArray);
  let firstTime = Infinity;
  let points = 0;
  let low = Infinity;
  let last = null;
  for (const arr of series) {
    for (let i = 0; i < arr.length; i += 2) {
      const t = arr[i];
      const v = arr[i + 1];
      if (v == null || v < 0) continue;
      points += 1;
      if (t < firstTime) firstTime = t;
      if (v < low) low = v;
      last = v;
    }
  }
  if (!points) return { points: 0, days: 0, lowCents: null, lastCents: null };
  const days = Math.round((Date.now() - keepaTimeToDate(firstTime).getTime()) / 86400000);
  return { points, days, lowCents: low === Infinity ? null : low, lastCents: last };
}

async function keepaBatch(asins) {
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${KEEPA_DOMAIN}` +
    `&asin=${asins.join(',')}&history=1&stats=0`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Keepa HTTP ${res.status} ${JSON.stringify(json.error || json).slice(0, 200)}`);
  }
  return json;
}

// ---------- run ----------
function pct(n, d) { return d ? `${Math.round((n / d) * 100)}%` : '0%'; }

async function main() {
  if (!TOKEN) throw new Error('STRAPI_API_TOKEN missing (set in nxt-sourcing/.env.local).');

  const products = await fetchAllProducts();
  const total = products.length;

  const merchantCounts = {};
  const amazonProducts = []; // { name, slug, asin }
  let withAmazon = 0;

  for (const p of products) {
    const offers = Array.isArray(p.offers) ? p.offers : [];
    const slugs = new Set();
    let asin = ASIN_RE.test(String(p.asin || '').toUpperCase()) ? String(p.asin).toUpperCase() : null;
    for (const o of offers) {
      const slug = (o.merchant?.slug || 'unknown').toLowerCase();
      slugs.add(slug);
      if (slug.startsWith('amazon')) asin = asin || extractAsin(o);
    }
    slugs.forEach((s) => { merchantCounts[s] = (merchantCounts[s] || 0) + 1; });
    if (asin) { withAmazon += 1; amazonProducts.push({ name: p.name, slug: p.slug, asin }); }
  }

  const uniqueAsins = [...new Set(amazonProducts.map((a) => a.asin))];

  console.log('\n══════════ KEEPA COVERAGE AUDIT ══════════\n');
  console.log('LAYER 1 — catalog & Amazon reach (Keepa is Amazon-only)\n');
  console.log(`  Total products in catalog .......... ${total}`);
  console.log(`  With a resolvable Amazon ASIN ...... ${withAmazon}  (${pct(withAmazon, total)})  <- Keepa-addressable ceiling`);
  console.log(`  Unique ASINs ....................... ${uniqueAsins.length}`);
  console.log(`  No Amazon offer (Keepa can't help) . ${total - withAmazon}  (${pct(total - withAmazon, total)})`);
  console.log('\n  Merchant distribution (products carrying each merchant):');
  Object.entries(merchantCounts).sort((a, b) => b[1] - a[1])
    .forEach(([m, c]) => console.log(`    ${String(c).padStart(4)}  ${m}`));

  if (!KEEPA_KEY) {
    console.log('\nLAYER 2 — skipped (no KEEPA_API_KEY set).');
    console.log('  Set KEEPA_API_KEY to measure real Amazon price-history depth per ASIN.');
    console.log('  Tip: a Keepa free/trial API key is enough to audit a small catalog.\n');
    verdict(total, withAmazon, null);
    return;
  }

  // LAYER 2
  const toQuery = uniqueAsins.slice(0, argLimit);
  console.log(`\nLAYER 2 — Keepa history depth (${toQuery.length} ASIN${toQuery.length === 1 ? '' : 's'})\n`);

  const results = [];
  let tokensLeft = null;
  for (let i = 0; i < toQuery.length; i += 100) {
    const batch = toQuery.slice(i, i + 100);
    let json;
    try { json = await keepaBatch(batch); }
    catch (e) { console.log(`  ! Keepa batch failed: ${e.message}`); break; }
    tokensLeft = json.tokensLeft ?? tokensLeft;
    for (const prod of json.products || []) {
      results.push({ asin: prod.asin, title: prod.title, ...analyseCsv(prod.csv) });
    }
  }

  const deep = results.filter((r) => r.days >= 365).length;
  const moderate = results.filter((r) => r.days >= 90 && r.days < 365).length;
  const shallow = results.filter((r) => r.points > 0 && r.days < 90).length;
  const none = results.filter((r) => r.points === 0).length;
  const avgDays = results.length ? Math.round(results.reduce((s, r) => s + r.days, 0) / results.length) : 0;

  results.sort((a, b) => b.days - a.days).forEach((r) => {
    const low = r.lowCents != null ? `$${(r.lowCents / 100).toFixed(2)}` : '—';
    console.log(`  ${(r.asin || '??').padEnd(11)} ${String(r.days).padStart(5)}d  ${String(r.points).padStart(5)} pts  low ${low.padStart(8)}  ${String(r.title || '').slice(0, 38)}`);
  });

  console.log('\n  Summary:');
  console.log(`    Deep history (>=1yr) .. ${deep}  (${pct(deep, results.length)})`);
  console.log(`    Moderate (3-12mo) ..... ${moderate}  (${pct(moderate, results.length)})`);
  console.log(`    Shallow (<3mo) ........ ${shallow}`);
  console.log(`    No history ............ ${none}`);
  console.log(`    Avg history depth ..... ${avgDays} days`);
  if (tokensLeft != null) console.log(`    Keepa tokens left ..... ${tokensLeft}`);

  verdict(total, withAmazon, { deep, moderate, count: results.length, avgDays });
}

function verdict(total, withAmazon, layer2) {
  console.log('\n──────────── READ ────────────');
  const reach = total ? withAmazon / total : 0;
  if (reach < 0.34) {
    console.log(`  Only ${pct(withAmazon, total)} of the catalog is on Amazon. Keepa would touch a minority`);
    console.log('  of products — your multi-merchant snapshot system is the better investment.');
  } else if (reach < 0.67) {
    console.log(`  ${pct(withAmazon, total)} of the catalog is on Amazon — Keepa could meaningfully enrich`);
    console.log('  the Amazon slice (esp. historical backfill), but is not a whole-site solution.');
  } else {
    console.log(`  ${pct(withAmazon, total)} of the catalog is on Amazon — strong Keepa fit for backfill + signals.`);
  }
  if (layer2) {
    const good = layer2.count ? (layer2.deep + layer2.moderate) / layer2.count : 0;
    console.log(`  Of ASINs checked, ${pct(layer2.deep + layer2.moderate, layer2.count)} have >=3mo of usable history (avg ${layer2.avgDays}d).`);
    console.log(good >= 0.6
      ? '  History depth is good — the backfill would visibly improve your charts.'
      : '  History is thin for this niche — backfill value is limited; weigh against cost.');
  }
  console.log('');
}

main().catch((e) => { console.error('Audit failed:', e.message); process.exit(1); });
