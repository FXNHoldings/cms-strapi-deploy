/**
 * Check that offer destinations still resolve. READ-ONLY by default.
 *
 *   node scripts/check-offer-liveness.mjs                    # report
 *   node scripts/check-offer-liveness.mjs --limit=200
 *   node scripts/check-offer-liveness.mjs --merchant=walmart
 *   node scripts/check-offer-liveness.mjs --write            # apply verdicts
 *
 * The site already skips any offer whose status is not "active"
 * (lib/commerce.ts), so retiring one here removes it from the storefront on the
 * next build. That is the point: a dead link on a product page is a visitor who
 * came to buy and left.
 *
 * NEVER FETCHES affiliateUrl. Requesting an Impact, Takeads or Amazon tracking
 * link registers a click on that network. A checker that did this nightly would
 * manufacture thousands of clicks that never converted, wrecking the EPC figures
 * and looking indistinguishable from click fraud to the network. Only the raw
 * productUrl is fetched — it is the same page, without the tracking hop.
 *
 * Verdicts, and why they differ:
 *
 *   404 / 410       gone. Definitive, so the offer is retired immediately.
 *   soft 404        a 2xx that redirected to the merchant's root. Extremely
 *                   common — most retailers bounce dead products to the
 *                   homepage rather than admit a 404 — and invisible to a
 *                   status-code-only check.
 *   5xx / timeout   the merchant having a moment. Never retires an offer on
 *                   its own; increments a failure counter and only retires
 *                   after --max-failures consecutive bad runs.
 *   2xx             alive. Clears the counter and stamps lastLinkCheckAt.
 *
 * Politeness is not optional: requests are capped globally, serialised per host
 * with a delay, and sent with a real user agent. Hammering merchants from a
 * server that also hosts the storefronts is how an IP gets blocked.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const WRITE = args.includes('--write');
const LIMIT = Number(flag('limit', Infinity));
const MERCHANT = flag('merchant', null);
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 6)));
const PER_HOST_DELAY_MS = Math.max(0, Number(flag('host-delay', 1500)));
const TIMEOUT_MS = Math.max(1000, Number(flag('timeout', 12000)));
const MAX_FAILURES = Math.max(1, Number(flag('max-failures', 3)));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';

const UA = 'Mozilla/5.0 (compatible; nxt-offer-checker/1.0; +https://nxt.bargains)';

/* ------------------------------------------------------------------- api -- */

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function readOffers() {
  const all = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'sort[0]': 'id:asc',
    });
    ['productUrl', 'title', 'status', 'linkFailures', 'lastLinkCheckAt'].forEach((f, i) =>
      q.append(`fields[${i}]`, f),
    );
    q.append('populate[merchant][fields][0]', 'name');
    q.append('populate[merchant][fields][1]', 'slug');
    if (MERCHANT) q.append('filters[merchant][slug][$eqi]', MERCHANT);

    const body = await api(`/api/commerce-offers?${q}`);
    const rows = body?.data ?? [];
    all.push(...rows);
    const pageCount = body?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount || all.length >= LIMIT) break;
  }
  return all.slice(0, LIMIT === Infinity ? undefined : LIMIT);
}

/* ---------------------------------------------------------------- checks -- */

const lastHitAt = new Map();

async function politeFetch(url) {
  const host = new URL(url).host;
  const wait = (lastHitAt.get(host) ?? 0) + PER_HOST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHitAt.set(host, Date.now());

  return fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** A 2xx that landed on the merchant's root is a dead product, not a live one. */
function isSoftNotFound(originalUrl, finalUrl) {
  try {
    const from = new URL(originalUrl);
    const to = new URL(finalUrl);
    const fromDeep = from.pathname.replace(/\/+$/, '').length > 1;
    const toShallow = to.pathname.replace(/\/+$/, '').length <= 1;
    return fromDeep && toShallow;
  } catch {
    return false;
  }
}

/**
 * A "gone" verdict is confirmed by asking again.
 *
 * Learned the hard way: Mwave returned 410 to the checker, 403 to a browser
 * user agent, and 202 to both a minute later — for one unchanged URL. Its edge
 * emits essentially arbitrary codes, and six live offers were retired on the
 * strength of a single 410. One request is an opinion; two agreeing is
 * evidence.
 */
async function confirmGone(url, first) {
  await sleep(4000);
  try {
    const res = await politeFetch(url);
    if (res.status === 404 || res.status === 410) {
      return { verdict: 'gone', reason: `${first.reason}, confirmed on retry`, code: res.status };
    }
    if (res.status < 400 && isSoftNotFound(url, res.url)) {
      return { verdict: 'gone', reason: `${first.reason}, confirmed on retry`, code: res.status };
    }
    return {
      verdict: 'blocked',
      reason: `${first.reason} then HTTP ${res.status} — merchant is inconsistent, not believed`,
      code: res.status,
    };
  } catch {
    return { verdict: 'transient', reason: `${first.reason}, retry failed`, code: first.code };
  }
}

async function checkOne(offer) {
  const url = offer.productUrl;
  if (!url || !/^https?:\/\//i.test(url)) {
    return { verdict: 'error', reason: 'no usable productUrl', code: null };
  }

  try {
    const res = await politeFetch(url);

    if (res.status === 404 || res.status === 410) {
      return confirmGone(url, { reason: `HTTP ${res.status}`, code: res.status });
    }
    if (res.status >= 500) {
      return { verdict: 'transient', reason: `HTTP ${res.status}`, code: res.status };
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      // Bot defence, not a verdict on the product. These merchants refuse any
      // non-browser request and will do so on every run, so counting them as
      // failures would retire their entire catalogue after three passes —
      // measured on the first dry run, where Bing Lee and Kogan AU returned 403
      // for four offers that are all perfectly alive. We cannot tell from here,
      // so we say so and change nothing.
      return { verdict: 'blocked', reason: `HTTP ${res.status} (bot defence)`, code: res.status };
    }
    if (res.status >= 400) {
      return { verdict: 'transient', reason: `HTTP ${res.status}`, code: res.status };
    }
    if (isSoftNotFound(url, res.url)) {
      return confirmGone(url, { reason: `redirected to ${new URL(res.url).host}/`, code: res.status });
    }
    return { verdict: 'alive', reason: `HTTP ${res.status}`, code: res.status };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS}ms` : error.message;
    return { verdict: 'transient', reason, code: null };
  }
}

/* ----------------------------------------------------------------- apply -- */

function decide(offer, result) {
  const failures = Number(offer.linkFailures ?? 0);
  const now = new Date().toISOString();

  if (result.verdict === 'alive') {
    return {
      patch: { status: 'active', linkFailures: 0, syncError: null, lastLinkCheckAt: now, linkStatusCode: result.code },
      action: offer.status === 'active' ? 'ok' : 'revived',
    };
  }

  if (result.verdict === 'blocked') {
    // Records what happened without touching status or the failure counter.
    return {
      patch: { syncError: result.reason, linkStatusCode: result.code },
      action: 'blocked',
    };
  }

  if (result.verdict === 'gone') {
    return {
      patch: { status: 'expired', linkFailures: failures + 1, syncError: result.reason, lastLinkCheckAt: now, linkStatusCode: result.code },
      action: 'retired',
    };
  }

  const next = failures + 1;
  if (next >= MAX_FAILURES) {
    return {
      patch: { status: 'error', linkFailures: next, syncError: result.reason, linkStatusCode: result.code },
      action: 'retired-after-retries',
    };
  }
  return {
    patch: { status: 'stale', linkFailures: next, syncError: result.reason, linkStatusCode: result.code },
    action: `strike ${next}/${MAX_FAILURES}`,
  };
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const offers = await readOffers();
  console.log(`${offers.length} offer(s) to check · concurrency ${CONCURRENCY} · ${PER_HOST_DELAY_MS}ms per host · ${WRITE ? 'WRITING' : 'read-only'}\n`);

  const tally = { ok: 0, revived: 0, retired: 0, 'retired-after-retries': 0, strike: 0, blocked: 0 };
  let index = 0;

  /* Phase one: check everything, write nothing. Holding the verdicts lets the
     merchant guard below see the whole picture before any of it is believed. */
  const checked = [];

  async function worker() {
    while (index < offers.length) {
      const offer = offers[index++];
      checked.push({ offer, result: await checkOne(offer) });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  /* Phase two: refuse to believe a merchant died all at once.
     If most of one merchant's checked offers come back gone, the likely
     explanation is the merchant's edge misbehaving — the failure mode that
     retired six live Mwave offers on a single inconsistent 410 — not that its
     catalogue vanished between runs. Needs a few offers before it can judge, so
     a merchant with one dead product is still handled normally. */
  const byMerchant = new Map();
  for (const entry of checked) {
    const key = entry.offer.merchant?.slug ?? entry.offer.merchant?.name ?? 'unknown';
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push(entry);
  }

  for (const [merchant, entries] of byMerchant) {
    const gone = entries.filter((e) => e.result.verdict === 'gone');
    if (entries.length >= 4 && gone.length / entries.length > 0.5) {
      console.log(
        `  ! ${merchant}: ${gone.length}/${entries.length} came back gone — treating as a merchant-side ` +
          `problem and retiring none of them.`,
      );
      for (const entry of gone) {
        entry.result = {
          verdict: 'blocked',
          reason: `${gone.length}/${entries.length} of this merchant looked gone — not believed`,
          code: entry.result.code,
        };
      }
    }
  }

  /* Phase three: apply. */
  for (const { offer, result } of checked) {
    const { patch, action } = decide(offer, result);

    if (action.startsWith('strike')) tally.strike += 1;
    else tally[action] = (tally[action] ?? 0) + 1;

    if (action !== 'ok') {
      const who = offer.merchant?.name ?? 'unknown';
      console.log(`  ${action.padEnd(22)} ${who.padEnd(14)} ${result.reason.slice(0, 46).padEnd(48)} ${(offer.title ?? '').slice(0, 42)}`);
    }

    if (WRITE) {
      try {
        await api(`/api/commerce-offers/${offer.documentId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: patch }),
        });
      } catch (error) {
        console.error(`  ! could not update ${offer.documentId}: ${error.message}`);
      }
    }
  }

  console.log(
    `\nalive ${tally.ok} · revived ${tally.revived} · retired ${tally.retired} · ` +
      `retired after retries ${tally['retired-after-retries']} · struck ${tally.strike} · ` +
      `blocked ${tally.blocked} (unknowable, left alone)`,
  );
  if (!WRITE) console.log('Read-only run. Nothing was changed — pass --write to apply.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
