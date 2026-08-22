/**
 * Reprice Amazon offers through DataForSEO. READ-ONLY by default.
 *
 *   node scripts/refresh-amazon-prices-dataforseo.mjs              # report
 *   node scripts/refresh-amazon-prices-dataforseo.mjs --write
 *   node scripts/refresh-amazon-prices-dataforseo.mjs --limit=25
 *
 * Replaces refresh-amazon-prices.sh, paused on 14 Aug 2026 because it ran
 * through a RapidAPI product-search key that no longer exists. Its last four
 * runs are the reason this script exists in the shape it does: each reported
 * {"ok":true, snapshots:0, offersUpdated:0, skipped:100}. A dead key produced
 * a green log for four days, because "skipped everything" was not treated as
 * failure. Here it is: if a run updates nothing, it exits non-zero and says so.
 *
 * Keying on ASIN. Nothing in the catalogue stores one — 0 of 681 products and
 * 0 of 196 Amazon offers — but 158 of those offers carry it in their URL as
 * /dp/XXXXXXXXXX, so it is extracted at run time. Offers without one are
 * reported rather than silently passed over, since that count is the thing
 * that tells you whether sourcing is degrading.
 *
 * Two API details, both learned by testing rather than from the docs:
 *   - language_code must be the locale 'en_AU'. A bare 'en' returns 40501
 *     "Invalid Field: 'language_code'", which reads like a wrong field name.
 *   - the price is in price_from, not price. `price` exists and is null.
 */

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const WRITE = args.includes('--write');
const LIMIT = Number(flag('limit', Infinity));
const LOCATION = Number(flag('location', 2036));
const LANGUAGE = flag('language', 'en_AU');
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 4)));
const COST_PER_CALL = 0.005;

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const ENDPOINT = 'https://api.dataforseo.com/v3/merchant/amazon/asin/live/advanced';

/* The password may already be a base64 login:password blob. Same handling as
   the other DataForSEO scripts, so one credential format works everywhere. */
function authHeader() {
  try {
    const [l, ...rest] = Buffer.from(DFS_PASSWORD, 'base64').toString('utf8').split(':');
    if (rest.length && l.includes('@')) return `Basic ${DFS_PASSWORD}`;
  } catch { /* not base64 */ }
  return `Basic ${Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64')}`;
}

async function strapi(pathname, init = {}) {
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

const asinOf = (url) => (String(url ?? '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) ?? [])[1] ?? null;

async function readAmazonOffers() {
  const all = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'filters[merchant][name][$containsi]': 'amazon',
    });
    ['productUrl', 'price', 'currency', 'title'].forEach((f, i) => q.append(`fields[${i}]`, f));
    q.append('populate[merchant][fields][0]', 'name');

    const body = await strapi(`/api/commerce-offers?${q}`);
    const rows = body?.data ?? [];
    all.push(...rows);
    if (page >= (body?.meta?.pagination?.pageCount ?? 1)) break;
  }
  return all;
}

async function priceFor(asin) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin, location_code: LOCATION, language_code: LANGUAGE }]),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json();
  const task = json?.tasks?.[0];
  if (task?.status_code !== 20000) throw new Error(`${task?.status_code}: ${task?.status_message}`);

  const item = task?.result?.[0]?.items?.[0];
  if (!item) return null;
  // price_from, not price — `price` is present and always null on this endpoint.
  const value = item.price_from ?? null;
  return value == null ? null : { price: Number(value), currency: item.currency ?? 'AUD' };
}

async function main() {
  const offers = await readAmazonOffers();
  const withAsin = offers.map((o) => ({ ...o, asin: asinOf(o.productUrl) })).filter((o) => o.asin);
  const without = offers.length - withAsin.length;
  const selected = LIMIT === Infinity ? withAsin : withAsin.slice(0, LIMIT);

  console.log(`${offers.length} Amazon offer(s) · ${withAsin.length} with an ASIN in the URL · ${without} without`);
  console.log(`${selected.length} selected · estimate $${(selected.length * COST_PER_CALL).toFixed(2)} · ${WRITE ? 'WRITING' : 'read-only'}\n`);

  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let index = 0;

  async function worker() {
    while (index < selected.length) {
      const offer = selected[index++];
      try {
        const found = await priceFor(offer.asin);
        if (!found) { failed += 1; console.log(`  no price   ${offer.asin}  ${(offer.title ?? '').slice(0, 46)}`); continue; }

        const before = offer.price == null ? null : Number(offer.price);
        if (before !== null && Math.abs(before - found.price) < 0.005) { unchanged += 1; continue; }

        console.log(`  ${String(before ?? '-').padStart(8)} -> ${String(found.price).padStart(8)} ${found.currency}  ${(offer.title ?? '').slice(0, 44)}`);
        if (WRITE) {
          await strapi(`/api/commerce-offers/${offer.documentId}`, {
            method: 'PUT',
            body: JSON.stringify({ data: { price: found.price, currency: found.currency, lastCheckedAt: new Date().toISOString() } }),
          });
        }
        updated += 1;
      } catch (error) {
        failed += 1;
        console.error(`  ! ${offer.asin}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nrepriced ${updated} · unchanged ${unchanged} · failed ${failed}`);
  if (!WRITE) console.log('Read-only run. Nothing was changed — pass --write to apply.');

  /* The whole point. Its predecessor reported success for four days while
     updating nothing, because nothing checked. A run that touches nothing is a
     broken run, and it must be loud enough to notice from a log tail. */
  if (selected.length > 0 && updated === 0 && unchanged === 0) {
    console.error('\nFAILED: every offer errored or returned no price. Treat this as an outage, not a quiet day.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
