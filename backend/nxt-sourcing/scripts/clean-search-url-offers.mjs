/**
 * Remove offers that only ever pointed at a search page. READ-ONLY by default.
 *
 *   node scripts/clean-search-url-offers.mjs            # report what would go
 *   node scripts/clean-search-url-offers.mjs --delete   # actually remove them
 *   node scripts/clean-search-url-offers.mjs --delete --include-orphans
 *
 * 742 of 1,934 offers link to a retailer's search page rather than a product:
 * "Buy at Mwave" drops the visitor on a list of search results. They exist
 * because the original sourcing created an offer for every retailer it guessed
 * might stock a product, then pointed each at that retailer's search URL. The
 * real product URL was never known.
 *
 * It cannot be recovered either. enrich-products-product-info asks Google for
 * the sellers of a product, but Google lists different merchants than these
 * offers name — for one sampled product it returned Lasoo, Mobileciti and eBay
 * AU, while the offers were Amazon AU, Bing Lee, Harvey Norman, JB Hi-Fi, Kogan
 * AU and The Good Guys. There is no overlap to match on, so no URL to repair
 * with.
 *
 * An offer that cannot name a product URL is not an offer. It is a guess, and
 * it costs a click.
 *
 * SAFETY. A product is never stripped bare: an offer is only removed if its
 * product keeps at least one offer with a real product URL. The 50 products
 * whose offers are *all* search URLs are skipped unless --include-orphans,
 * because emptying them is a re-sourcing decision, not a cleanup one.
 *
 * Every removal is written to reports/ in full before anything is deleted, so
 * the set can be recreated.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const DELETE = args.includes('--delete');
const INCLUDE_ORPHANS = args.includes('--include-orphans');
const LIMIT = Number(flag('limit', Infinity));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** Same test the checker uses, so the two agree on what a search URL is. */
function isSearchUrl(url) {
  try {
    const u = new URL(url);
    if (/\/(search|catalogsearch|find|results)\b/i.test(u.pathname)) return true;
    return ['q', 'query', 's', 'k', 'keyword', 'search'].some((k) => u.searchParams.has(k));
  } catch {
    return false;
  }
}

async function readOffers() {
  const all = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'sort[0]': 'id:asc',
    });
    ['productUrl', 'affiliateUrl', 'title', 'price', 'currency', 'status', 'source'].forEach((f, i) =>
      q.append(`fields[${i}]`, f),
    );
    q.append('populate[merchant][fields][0]', 'name');
    q.append('populate[product][fields][0]', 'slug');
    q.append('populate[product][fields][1]', 'name');

    const body = await api(`/api/commerce-offers?${q}`);
    const rows = body?.data ?? [];
    all.push(...rows);
    if (page >= (body?.meta?.pagination?.pageCount ?? 1)) break;
  }
  return all;
}

async function main() {
  const offers = await readOffers();

  const byProduct = new Map();
  for (const offer of offers) {
    const key = offer.product?.slug ?? `(no product) ${offer.documentId}`;
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(offer);
  }

  const doomed = [];
  const orphanProducts = [];

  for (const [slug, list] of byProduct) {
    const search = list.filter((o) => isSearchUrl(o.productUrl));
    if (!search.length) continue;

    const real = list.length - search.length;
    if (real === 0) {
      orphanProducts.push({ slug, offers: search.length });
      if (!INCLUDE_ORPHANS) continue;
    }
    doomed.push(...search);
  }

  const selected = LIMIT === Infinity ? doomed : doomed.slice(0, LIMIT);

  console.log(`${offers.length} offers · ${doomed.length} on search URLs and safe to remove`);
  console.log(
    `${orphanProducts.length} product(s) would be left with no offers at all — ` +
      `${INCLUDE_ORPHANS ? 'INCLUDED by --include-orphans' : 'skipped'}`,
  );
  console.log(`${selected.length} selected · ${DELETE ? 'DELETING' : 'read-only'}\n`);

  const byMerchant = new Map();
  for (const o of selected) {
    const m = o.merchant?.name ?? 'unknown';
    byMerchant.set(m, (byMerchant.get(m) ?? 0) + 1);
  }
  for (const [m, n] of [...byMerchant].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${m}`);
  }

  // The record is written before anything is removed, never after.
  const reportDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const out = path.join(reportDir, `removed-search-url-offers-${DELETE ? 'applied' : 'preview'}.json`);
  fs.writeFileSync(out, JSON.stringify({ orphanProducts, offers: selected }, null, 2));
  console.log(`\nfull record: ${out}`);

  if (!DELETE) {
    console.log('Read-only. Nothing was removed — pass --delete to apply.');
    return;
  }

  let removed = 0;
  for (const offer of selected) {
    try {
      await api(`/api/commerce-offers/${offer.documentId}`, { method: 'DELETE' });
      removed += 1;
    } catch (error) {
      console.error(`  ! ${offer.documentId}: ${error.message}`);
    }
  }
  console.log(`\nremoved ${removed} of ${selected.length}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
