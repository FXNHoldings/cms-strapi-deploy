/**
 * Source a nxt.bargains category from Google Shopping, in the shape
 * nxtsmarthome.com.au uses: search by category keyword, then re-query per
 * product for prices, then harvest reviews from the tasks already paid for.
 *
 *   node scripts/source-category-pipeline.mjs --category=smart-phones --limit=10
 *   node scripts/source-category-pipeline.mjs --category=smart-phones --limit=10 --write
 *
 *   1. discover  merchant/google/products, depth 20, US   -> distinct products
 *   2. prices    merchant/google/products per product     -> offers from allowed retailers
 *   3. reviews   re-collect phase 1+2 tasks (FREE) -> gid -> merchant/google/reviews
 *
 * Phase 3 is the reason task ids are written to a state file. `task_get` on an
 * already-completed task costs nothing, so the gid needed for reviews comes out
 * of responses that were already bought in phases 1 and 2. Calling
 * `product_info` for it instead is a wasted request that returns no gid at all —
 * that is what made an earlier run report reviews as unavailable.
 *
 * Two limits of this endpoint drive the design, both measured rather than
 * assumed (40 items, one live Smart Phones query):
 *
 *   - `domain` and `url` are null on every item. Only `shopping_url` is set and
 *     it points at a Google search page, not a storefront. So retailers are
 *     matched on the seller NAME, and an offer's link falls back to that
 *     retailer's own search URL. There is no direct product link to be had here.
 *   - `gtin` is never returned. The field stays null rather than being filled
 *     with a guess.
 *
 * Ratings are written only where the response carries them. A missing rating is
 * left null — inventing a default is how the AU catalogue ended up with 4.7
 * stars and 120 reviews on products nobody had reviewed.
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
const NO_REVIEWS = args.includes('--no-reviews');
const CATEGORY = flag('category', null);
/* Explicit product names, "A|B|C" — sources exactly these instead of sweeping
 * the category. Used when the wanted products are already known, e.g. a launch
 * line-up that a broad category query buries under older stock. */
const REFRESH = args.includes('--refresh');
/* Re-evaluate offers for products that already exist. Used after a matching fix
 * to correct offers already written, without duplicating the products. */
const REFRESH_OFFERS = args.includes('--refresh-offers');
const NAMES_FILE = flag('products-file', null);
const NAMES = (
  NAMES_FILE
    ? fs.readFileSync(NAMES_FILE, 'utf8').split('\n')
    : (flag('products', '') || '').split('|')
).map((n) => n.trim()).filter(Boolean);
const LIMIT = Number(flag('limit', 10));
const DEPTH = Number(flag('depth', 20));
const PRIORITY = Number(flag('priority', 2));
const LOCATION = Number(flag('location', 2840)); // United States
const LANGUAGE = flag('language', 'en');
const CONCURRENCY = Number(flag('concurrency', 8));
/*
 * Absolute price floor. The anchor check needs a Tier 1/2 offer to measure
 * against; a product carrying only marketplace listings has none, which let a
 * $42.75 "Pixel 9 Pro XL" through. Set per category — a phone under $50 is not
 * a phone, but that floor would be nonsense for smart plugs.
 */
const MIN_PRICE = Number(flag('min-price', 0));
const STATE = path.join(ROOT, 'reports', `pipeline-tasks-${CATEGORY ?? 'all'}.json`);
const OUT = path.join(ROOT, 'reports', `pipeline-${CATEGORY ?? 'all'}.json`);

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';

/** The tag nxt.bargains filters its product pool by (lib/strapi.ts). */
const SITE_TAG = 'nxt-bargains';

const EP = {
  products: 'https://api.dataforseo.com/v3/merchant/google/products',
  reviews: 'https://api.dataforseo.com/v3/merchant/google/reviews',
};

/**
 * Category search keywords. One query per nxt.bargains category — these are the
 * storefront's own categories, not the AU or skincare ones that share the table.
 */
const CATEGORY_QUERIES = {
  'smart-phones': 'unlocked 5G smartphone',
  'laptops': 'laptop computer',
  'tablets': 'tablet android ipad',
  'headphones': 'wireless noise cancelling headphones earbuds',
  'smartwatches': 'smartwatch fitness tracker',
  'smart-tvs': 'smart tv 4k',
  'smart-speakers': 'smart speaker voice assistant',
  'smart-cameras': 'smart home security camera',
  'video-doorbells': 'video doorbell',
  'smart-door-locks': 'smart door lock keyless entry',
  'smart-light-bulbs': 'smart light bulb led wifi',
  'smart-plugs': 'smart plug wifi outlet',
  'raspberry-pi': 'raspberry pi board kit',
};

/* ------------------------------------------------------- retailer allowlist */

/**
 * US retailers whose prices belong on a comparison page. Tiers are ordered so a
 * specific name wins before a generic one, and the marketplaces sit last.
 *
 * Everything absent from this list is dropped. That is the point: an earlier
 * run kept whatever Google returned and half the offers came from parallel
 * importers (Etoren, MyWorldPhone, Cellification, ElectronicsForce, Swiftronics)
 * and phone-buyback sites (ItsWorthMore), which carry no US warranty and are not
 * a price a reader can act on.
 */
const RETAILERS = [
  // Tier 1 — national retailers
  { name: 'Best Buy', tier: 1, patterns: ['best buy', 'bestbuy'], search: 'https://www.bestbuy.com/site/searchpage.jsp?st=' },
  { name: 'Walmart', tier: 1, patterns: ['walmart'], search: 'https://www.walmart.com/search?q=' },
  { name: 'Target', tier: 1, patterns: ['target'], search: 'https://www.target.com/s?searchTerm=' },
  { name: 'Costco', tier: 1, patterns: ['costco'], search: 'https://www.costco.com/CatalogSearch?keyword=' },
  { name: "Sam's Club", tier: 1, patterns: ["sam's club", 'sams club'], search: 'https://www.samsclub.com/s/' },
  { name: 'Newegg', tier: 1, patterns: ['newegg'], search: 'https://www.newegg.com/p/pl?d=' },
  { name: 'Micro Center', tier: 1, patterns: ['micro center', 'microcenter'], search: 'https://www.microcenter.com/search/search_results.aspx?Ntt=' },
  { name: 'B&H Photo', tier: 1, patterns: ['b&h', 'bhphoto'], search: 'https://www.bhphotovideo.com/c/search?q=' },
  { name: 'Adorama', tier: 1, patterns: ['adorama'], search: 'https://www.adorama.com/l/?searchinfo=' },
  { name: 'Home Depot', tier: 1, patterns: ['home depot', 'homedepot'], search: 'https://www.homedepot.com/s/' },
  { name: "Lowe's", tier: 1, patterns: ["lowe's", 'lowes'], search: 'https://www.lowes.com/search?searchTerm=' },
  { name: 'Staples', tier: 1, patterns: ['staples'], search: 'https://www.staples.com/search?query=' },
  { name: 'Office Depot', tier: 1, patterns: ['office depot', 'officedepot'], search: 'https://www.officedepot.com/catalog/search.do?Ntt=' },
  { name: "Kohl's", tier: 1, patterns: ["kohl's", 'kohls'], search: 'https://www.kohls.com/search.jsp?search=' },
  { name: "Macy's", tier: 1, patterns: ["macy's", 'macys'], search: 'https://www.macys.com/shop/featured/' },
  { name: 'Sears', tier: 1, patterns: ['sears'], search: 'https://www.sears.com/search=' },
  { name: 'Nebraska Furniture Mart', tier: 1, patterns: ['nebraska furniture', 'nfm'], search: 'https://www.nfm.com/search?q=' },
  { name: 'Zoro', tier: 1, patterns: ['zoro'], search: 'https://www.zoro.com/search?q=' },

  // Tier 2 — brand-direct stores
  { name: 'Apple', tier: 2, patterns: ['apple store', 'apple.com', 'apple'], search: 'https://www.apple.com/us/search/' },
  { name: 'Samsung', tier: 2, patterns: ['samsung'], search: 'https://www.samsung.com/us/search/searchMain?listType=g&searchTerm=' },
  { name: 'Google Store', tier: 2, patterns: ['google store'], search: 'https://store.google.com/us/search?q=' },
  { name: 'Motorola', tier: 2, patterns: ['motorola'], search: 'https://www.motorola.com/us/search?q=' },
  { name: 'OnePlus Official Store', tier: 2, patterns: ['oneplus'], search: 'https://www.oneplus.com/us/search?query=' },
  { name: 'Sonos', tier: 2, patterns: ['sonos'], search: 'https://www.sonos.com/en-us/search?q=' },
  { name: 'Anker', tier: 2, patterns: ['anker'], search: 'https://www.anker.com/search?q=' },
  { name: 'eufy', tier: 2, patterns: ['eufy'], search: 'https://www.eufy.com/search?q=' },
  { name: 'Ring', tier: 2, patterns: ['ring.com', 'ring '], search: 'https://ring.com/search?q=' },
  { name: 'Reolink', tier: 2, patterns: ['reolink'], search: 'https://reolink.com/search?q=' },
  { name: 'LIFX', tier: 2, patterns: ['lifx'], search: 'https://www.lifx.com/search?q=' },
  { name: 'Nanoleaf', tier: 2, patterns: ['nanoleaf'], search: 'https://nanoleaf.me/en-US/search?q=' },
  { name: 'Dreame', tier: 2, patterns: ['dreame'], search: 'https://www.dreametech.com/search?q=' },

  // Tier 3 — marketplaces. Sellers fold to the parent.
  { name: 'Amazon', tier: 3, patterns: ['amazon'], search: 'https://www.amazon.com/s?k=' },
  { name: 'eBay', tier: 3, patterns: ['ebay'], search: 'https://www.ebay.com/sch/i.html?_nkw=' },
  { name: 'Poshmark', tier: 3, patterns: ['poshmark'], search: 'https://poshmark.com/search?query=' },
  { name: 'Mercari', tier: 3, patterns: ['mercari'], search: 'https://www.mercari.com/search/?keyword=' },
];

/** Carriers quote a monthly instalment, not a purchase price. See isInstalment. */
const CARRIERS = [
  'at&t', 'verizon', 't-mobile', 'boost mobile', 'cricket', 'consumer cellular',
  'total wireless', 'us mobile', 'straight talk', 'visible', 'metro by t-mobile',
  'xfinity mobile', 'spectrum mobile', 'page plus', 'optimum mobile', 'flash mobile',
];

const CONDITION_BAD = /refurb|renewed|restored|pre-?owned|\bused\b|open box|for parts|grade [abc]\b/i;

/**
 * A keyword query returns the accessories for a product alongside the product.
 * A search for "Google Pixel 10 Pro XL" came back with a $29.99 Pixelsnap case
 * and a $44.99 OtterBox, and those became the two cheapest "offers" — a $29.99
 * headline price on an $800 phone. Title overlap alone cannot catch it: the case
 * contains every word of the phone's name.
 */
const ACCESSORY = /\b(case|cover|skin|sleeve|pouch|holster|screen protector|tempered glass|charger|cable|adapter|dock|mount|holder|stand|stylus|lens|film|bumper|grip|strap|band|kit for|for [a-z]+ \d)\b/i;

/**
 * Listings for devices that are damaged or cannot be activated. Marketplace
 * sellers state this in the title without ever writing "used", so the condition
 * filter misses it: a Galaxy S21 at $99.99 was "Missing ..." and a Galaxy A16 at
 * $47.99 was "At&t Account_past_due" — a phone blacklisted for unpaid finance.
 * Neither is a price a reader can act on.
 */
const ENCUMBERED = /\b(missing|cracked|damaged|broken|faulty|spares|salvage|as-?is|parts only|bad esn|blacklist|past_?due|icloud ?locked|activation ?locked|financed|no power|screen burn|does ?n[o']?t work|can'?t activate|cannot activate|carrier locked|network locked|sim locked|bad imei)\b/i;

/** Variant words that make a different SKU. "S22" and "S22+" are not one phone. */
const VARIANT_WORDS = [
  'pro', 'plus', 'max', 'ultra', 'xl', 'mini', 'se', 'fold', 'flip', 'lite', 'fe', 'edge', 'air',
  // Watch editions and displays: a Fenix 8 Solar is not a Fenix 8 AMOLED.
  'classic', 'solar', 'amoled', 'microled', 'music', 'square', 'titanium',
  // "Keypad" and "Keypad Touch" are two different Yale locks at two prices.
  'touch',
  // Distinct product names rather than options: Bose Ultra Open, LinkBuds Fit.
  'elite', 'open', 'fit',
  // A roman numeral carries no digit, so "Bravia 8 II" and "Bravia 8" reduced to
  // the same model token and were indistinguishable.
  'ii', 'iii',
];

/*
 * Descriptors, matched directionally rather than by set equality.
 *
 * Treating these as strict variants cost most of a run: every Govee and TP-Link
 * "(Matter)" product and the Hue Starter Kit were rejected, because retailers
 * routinely omit the word from a title that is otherwise the right product.
 *
 * So a listing naming a *different* value in a group is rejected, and a listing
 * naming none is accepted — the same trade already made for capacity, case size
 * and connectivity. A listing that adds a descriptor the product lacks is also
 * rejected, which is what keeps a Plug-In camera off a Battery product.
 */
const DESCRIPTOR_GROUPS = [
  ['battery', 'poe', 'plug in', 'plugin', 'hardwired', 'wired'],
  ['amoled', 'microled', 'solar'],
  ['starter kit', 'bridge'],
  ['matter'],
];

function descriptorOf(raw, group) {
  const s = normaliseSku(raw);
  return group.find((w) => new RegExp(`\\b${w.replace(/ /g, '[ -]')}\\b`).test(s)) ?? null;
}

function variantSet(raw) {
  // Normalised, or "\bflip\b" fails to see the "Flip" in "Flip7" and a real
  // listing of the phone is judged a different variant.
  const s = normaliseSku(raw);
  const out = new Set();
  for (const v of VARIANT_WORDS) if (new RegExp(`\\b${v}\\b`).test(s)) out.add(v);
  // "S22+" and "S22 Plus" are the same device written two ways.
  if (/\w\+/.test(s)) out.add('plus');
  return out;
}

/*
 * Retailers write the same SKU several ways: "Flip7" for "Flip 7", "128 GB" for
 * "128GB". Normalise both before comparing, or a real listing of the product
 * fails the match on spacing alone.
 */
function normaliseSku(raw) {
  return skuNorm(raw).replace(/([a-z])(\d)/g, '$1 $2');   // "flip7" -> "flip 7"
}

/*
 * Capacity joined, but letters left attached to their digits. Splitting them
 * destroys the model prefix — "S26" and "A26" both became "26", and a $280
 * Galaxy A26 was priced as a Galaxy S26. Only variant and word-overlap checks
 * may use the split form; identity checks must use this one.
 */
function skuNorm(raw) {
  return String(raw || '').toLowerCase()
    .replace(/(\d+)\s*(gb|tb)\b/g, '$1$2')
    // "11-inch", "11 inch", '11"' -> "11inch", so screen size is one token that
    // can be compared as a dimension rather than mistaken for a model number.
    .replace(/(\d{2,3}(?:\.\d)?)\s*-?\s*(?:inch(?:es)?\b|["\u201d])/g, '$1inch')
    /*
     * Split a digit from the word before it only when that word is three or
     * more letters — "ultra2" is Ultra 2, but "s26" and "gt5" are model codes
     * whose letter is part of the identity. Splitting those made a Galaxy A26
     * indistinguishable from an S26.
     */
    .replace(/([a-z]{3,})(\d)/g, '$1 $2');
}

/** Screen size. An 11-inch iPad Air is not the 13-inch one. */
function screenSizeOf(raw) {
  const m = skuNorm(raw).match(/\b(\d{2,3}(?:\.\d)?)inch\b/);
  return m ? `${m[1]}inch` : null;
}

/*
 * Apple silicon tier: base, Pro or Max.
 *
 * The variant check cannot see this, because "Pro" is already in the family name
 * — a MacBook *Pro* with an M5 and a MacBook *Pro* with an M5 *Pro* produce the
 * same variant set, so the base model was quoting the Pro chip's price. The tier
 * has to be read from the chip token itself.
 */
function chipTierOf(raw) {
  const s = normaliseSku(raw);
  const m = s.match(/\bm\s?\d\s*(pro|max|ultra)\b/);
  if (m) return m[1];
  return /\bm\s?\d\b/.test(s) ? 'base' : null;
}

/*
 * Release year, compared directionally like every other dimension.
 *
 * Years are dropped from the model tokens because "(M4, 2024)" would otherwise
 * demand the string "2024" in iPad titles that never carry it. But for a laptop
 * refresh — ROG Zephyrus G14 (2024) against (2025) — the year is the only thing
 * telling two products apart, so a listing naming a *different* year has to be
 * rejected even though one naming none is still accepted.
 */
function yearOf(raw) {
  const m = skuNorm(raw).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

/** Watch case size. Like capacity, it changes the SKU and the price. */
function caseSizeOf(raw) {
  const m = skuNorm(raw).match(/\b(\d{2})\s*mm\b/);
  return m ? `${m[1]}mm` : null;
}

/*
 * Cellular models cost more than their Bluetooth/Wi-Fi counterparts, and the
 * two are listed under near-identical titles. Treated directionally: a cellular
 * product must not take a non-cellular listing's price, and vice versa. Titles
 * that state neither are still allowed, as most base models omit it.
 */
function connectivityOf(raw) {
  const t = String(raw || '').toLowerCase();
  if (/\b(lte|cellular|4g|5g)\b/.test(t)) return 'cellular';
  if (/\b(bluetooth|wi-?fi|gps only|gps)\b/.test(t)) return 'basic';
  return null;
}

/** Storage size, the one digit-token that changes the price materially. */
function capacityOf(raw) {
  const m = skuNorm(raw).match(/\b(\d+)(gb|tb)\b/);
  return m ? `${m[1]}${m[2]}` : null;
}

/** Model-number tokens, capacity excluded — it is checked separately. */
function modelTokens(raw) {
  /*
   * Any word containing a digit. The older pattern could not capture a mixed run
   * such as "1000xm6", leaving Sony's WH-1000XM6 with no model token at all —
   * which would have let it take an XM5's price.
   */
  const out = new Set(skuNorm(raw).match(/\b[a-z0-9]*\d[a-z0-9]*\b/g) ?? []);
  for (const t of [...out]) {
    // Capacity, case size and screen size are compared as their own dimensions.
    if (/^\d+(gb|tb|mm)$/.test(t) || /^\d+(\.\d)?inch$/.test(t)) out.delete(t);
    /*
     * Release years are dropped. "(M4, 2024)" would otherwise demand the string
     * "2024" in a listing title that almost never carries it, while the chip
     * token (m4, a17) already identifies the generation. The year still counts
     * toward title overlap, so it is not ignored entirely.
     */
    if (/^(19|20)\d{2}$/.test(t)) out.delete(t);
  }
  return out;
}

/*
 * A wanted token is satisfied by an identical listing token, or — only when the
 * wanted token is bare digits — by one ending in it, so "Flip 7" still matches
 * "Flip7". A lettered token like "s26" demands an exact match, which is what
 * keeps the A-series out of the S-series, and "16" will not match "16e".
 */
function modelTokensMatch(want, have) {
  for (const w of want) {
    if (have.has(w)) continue;
    if (/^\d+$/.test(w) && [...have].some((h) => h.endsWith(w))) continue;
    return false;
  }
  return true;
}

/**
 * Does this listing describe the product, or merely mention it?
 *
 * Rejects accessories, different variants (Pixel 10 sold as Pixel 10 Pro XL) and
 * different capacities. Erring towards rejection is deliberate — a missing offer
 * costs a comparison row, a wrong one puts a false price next to a buy button.
 */
function isSameProduct(listingTitle, productName) {
  const t = String(listingTitle || '');
  if (!t) return false;
  if (ACCESSORY.test(t) && !ACCESSORY.test(productName)) return false;
  if (ENCUMBERED.test(t)) return false;

  const vp = variantSet(productName);
  const vt = variantSet(t);
  if (vp.size !== vt.size || [...vp].some((v) => !vt.has(v))) return false;

  if (!modelTokensMatch(modelTokens(productName), modelTokens(t))) return false;

  /*
   * Capacity is checked only when the listing states one. Many titles omit it
   * entirely, and rejecting those would discard most of a product's real
   * offers — but a listing that names a *different* capacity is a different
   * SKU at a different price and must not be priced as this one.
   */
  const cw = capacityOf(productName);
  const cl = capacityOf(t);
  if (cw && cl && cw !== cl) return false;

  const sw = caseSizeOf(productName);
  const sl = caseSizeOf(t);
  if (sw && sl && sw !== sl) return false;

  const zw = screenSizeOf(productName);
  const zl = screenSizeOf(t);
  if (zw && zl && zw !== zl) return false;

  const nw = connectivityOf(productName);
  const nl = connectivityOf(t);
  if (nw && nl && nw !== nl) return false;

  const cw2 = chipTierOf(productName);
  const cl2 = chipTierOf(t);
  if (cw2 && cl2 && cw2 !== cl2) return false;

  const yw = yearOf(productName);
  const yl = yearOf(t);
  if (yw && yl && yw !== yl) return false;

  for (const group of DESCRIPTOR_GROUPS) {
    const dw = descriptorOf(productName, group);
    const dl = descriptorOf(t, group);
    if (dl && dw !== dl) return false;
  }

  return scoreTitle(t, productName) >= 0.6;
}

/**
 * Google mixes its own refinement chips into the results — "Unlocked 5G Samsung
 * smartphones" is a filter link, not something anyone sells. They arrive with a
 * generic adjective as the leading word and a plural category noun at the end.
 */
const CHIP_TAIL = /\b(smartphones|phones|laptops|tablets|headphones|earbuds|speakers|cameras|doorbells|locks|bulbs|plugs|watches|tvs)\s*$/i;
const CHIP_HEAD = /^(unlocked|best|top|new|cheap|refurbished|android|smart|wireless|budget)\b/i;

function isRefinementChip(title) {
  const t = String(title || '');
  return CHIP_TAIL.test(t) && CHIP_HEAD.test(t);
}

function matchRetailer(sellerRaw) {
  const s = String(sellerRaw || '').toLowerCase();
  if (!s) return null;
  for (const r of RETAILERS) {
    if (r.patterns.some((p) => s.includes(p))) return r;
  }
  return null;
}

function isCarrier(sellerRaw) {
  const s = String(sellerRaw || '').toLowerCase();
  return CARRIERS.some((c) => s.includes(c));
}

/** A phone under $200 from a carrier is a monthly payment, not a handset price. */
function isInstalment(sellerRaw, price) {
  return isCarrier(sellerRaw) && price < 200;
}

/** "eBay - everythingforlesss" is one marketplace and one seller, not a merchant. */
function splitSeller(raw) {
  const parts = String(raw || '').split(' - ');
  return { head: parts[0].trim(), sub: parts.slice(1).join(' - ') || null };
}

/* ------------------------------------------------------------------ helpers */

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

const spend = { paid: 0, free: 0 };

/** Post tasks, remember their ids, poll them. Returns Map(tag -> {result}|{error}). */
async function runTasks(kind, payloads, state) {
  const base = EP[kind];
  const byTag = new Map();

  /*
   * Anything already posted in an earlier run is re-collected instead of
   * re-posted. task_get on a finished task is not billed, so resuming after a
   * write failure costs nothing rather than repeating the whole spend. Pass
   * --refresh to force fresh queries when the prices themselves are stale.
   */
  const todo = [];
  for (const b of payloads) {
    const rec = state[b.tag];
    if (!REFRESH && rec?.id && rec.kind === kind) { byTag.set(b.tag, { id: rec.id }); spend.free += 1; }
    else todo.push(b);
  }
  if (byTag.size) console.log(`   reusing ${byTag.size} task(s) from a previous run (free)`);

  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    const res = await fetch(`${base}/task_post`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map((b) => ({ ...b.payload, tag: b.tag, priority: PRIORITY }))),
      signal: AbortSignal.timeout(120_000),
    });
    spend.paid += batch.length;
    if (!res.ok) throw new Error(`${kind} task_post HTTP ${res.status}`);
    for (const t of (await res.json()).tasks ?? []) {
      const tag = t.data?.tag ?? null;
      if (t.status_code === 20100 && t.id) {
        byTag.set(tag, { id: t.id });
        state[tag] = { kind, id: t.id };
      } else {
        byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` });
      }
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  await collect(base, byTag);
  return byTag;
}

/** Poll task_get until each task resolves. Free for tasks already completed. */
async function collect(base, byTag) {
  const deadline = Date.now() + 45 * 60 * 1000;
  const pending = [...byTag.entries()].filter(([, v]) => v.id);
  let done = 0;
  await pool(pending, CONCURRENCY, async ([tag, v]) => {
    for (;;) {
      try {
        const r = await fetch(`${base}/task_get/advanced/${v.id}`, {
          headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(90_000),
        });
        const text = await r.text();
        if (r.ok && text.trim().startsWith('{')) {
          const t = JSON.parse(text).tasks?.[0];
          if (t?.status_code === 20000) { byTag.set(tag, { result: t.result?.[0] ?? null }); break; }
          if (t && t.status_code !== 40602) { byTag.set(tag, { error: `${t.status_code}: ${t.status_message}` }); break; }
        }
      } catch (e) { if (!/aborted|timeout|fetch failed|JSON/i.test(String(e.message))) throw e; }
      if (Date.now() > deadline) { byTag.set(tag, { error: 'timed out' }); break; }
      await new Promise((res) => setTimeout(res, 10_000));
    }
    if (++done % 5 === 0 || done === pending.length) process.stdout.write(`    ${done}/${pending.length}\r`);
  });
  if (pending.length) process.stdout.write('\n');
}

/** Re-read tasks recorded earlier. task_get on a finished task is not billed. */
async function recollect(kind, tags, state) {
  const byTag = new Map();
  for (const tag of tags) {
    const rec = state[tag];
    if (rec?.id && rec.kind === kind) { byTag.set(tag, { id: rec.id }); spend.free += 1; }
  }
  await collect(EP[kind], byTag);
  return byTag;
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
    throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);

const normalise = (s) => normaliseSku(s)
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const STOP = new Set(['the', 'and', 'with', 'for', 'new', 'sale', 'unlocked', 'smartphone', 'phone']);

/** Overlap of a candidate title against a reference, 0..1. */
/*
 * Length > 1, not > 2. Retailers list "Pixel 11 Frost 256GB (AT&T)" without the
 * word "Google", so dropping the model number left only one shared word out of
 * two and the real phone scored below the gate. The model number is the most
 * identifying token in the title and has to count.
 */
function scoreTitle(candidate, reference) {
  const a = new Set(normalise(candidate).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
  const b = new Set(normalise(reference).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const w of b) if (a.has(w)) hits += 1;
  return hits / b.size;
}

/**
 * Google returns each listing separately, so ten sellers of one phone arrive as
 * ten items. Group them by the significant words in the title so a product is a
 * product and its listings become its offers.
 */
function groupIntoProducts(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.title) continue;
    if (CONDITION_BAD.test(it.title)) continue;
    if (isRefinementChip(it.title)) continue;
    const key = normalise(it.title).split(' ')
      .filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 6).sort().join(' ');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.values()]
    // The listing with the most complete data speaks for the group.
    .map((g) => ({
      items: g,
      lead: [...g].sort((a, b) =>
        (b.product_rating?.value ? 1 : 0) - (a.product_rating?.value ? 1 : 0)
        || String(b.title).length - String(a.title).length)[0],
    }))
    .sort((a, b) => b.items.length - a.items.length);
}

/* --------------------------------------------------------------------- main */

if (!CATEGORY) { console.error('usage: --category=<slug> [--limit=10] [--write]'); process.exit(1); }
if (!DFS_LOGIN || !DFS_PASSWORD) { console.error('DATAFORSEO credentials not set.'); process.exit(1); }
const KEYWORD = NAMES.length ? null : CATEGORY_QUERIES[CATEGORY];
if (!NAMES.length && !KEYWORD) { console.error(`No category query for "${CATEGORY}". Known: ${Object.keys(CATEGORY_QUERIES).join(', ')}`); process.exit(1); }

fs.mkdirSync(path.dirname(STATE), { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};

console.log(`category : ${CATEGORY}`);
console.log(NAMES.length ? `products : ${NAMES.length} named` : `keyword  : "${KEYWORD}"`);
console.log(`location : ${LOCATION} (US)   depth: ${DEPTH}   limit: ${LIMIT}`);
console.log(`mode     : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);

/* ---- phase 1: discover products ---- */

let products = [];

/*
 * Turn one search response into a product record. The lead listing is the one
 * whose title best describes the product; the rest of the group become offers.
 */
function toProduct(lead, items) {
  const rating = lead.product_rating?.value ?? null;
  const votes = lead.product_rating?.votes_count ?? null;
  return {
    name: lead.title,
    slug: slugify(lead.title),
    brand: (lead.title || '').split(' ')[0] || null,
    // Only what the response actually carries. No default rating, no default count.
    rating: typeof rating === 'number' ? rating : null,
    ratingCount: typeof votes === 'number' ? votes : null,
    imageUrl: lead.product_images?.[0] ?? null,
    googleProductId: lead.product_id ?? null,
    gid: lead.gid ?? null,
    // Never present on this endpoint; kept explicit so the gap is visible.
    gtin: lead.gtin ?? null,
    discoveryOffers: items,
  };
}

if (NAMES.length) {
  console.log('1. resolving named products ...');
  const found = await runTasks('products', NAMES.map((n) => ({
    tag: `find:${slugify(n)}`,
    payload: { keyword: n, location_code: LOCATION, language_code: LANGUAGE, depth: DEPTH },
  })), state);

  for (const wanted of NAMES) {
    const res = found.get(`find:${slugify(wanted)}`);
    /*
     * A task that errored or timed out is not the same as a product Google does
     * not sell, and reporting both as "no exact match" sent me looking for a
     * matching bug that did not exist. Standard-queue tasks can outlast the
     * polling window; their ids are in the state file, so a re-run collects
     * them for free.
     */
    if (res?.error) {
      console.log(`   ! task failed for "${wanted}" (${res.error}) — re-run to collect it`);
      continue;
    }
    const items = res?.result?.items ?? [];
    /*
     * A search for "Google Pixel 11" returns the Pro and Pro XL too. isSameProduct
     * enforces variant equality, so only listings of the exact model survive —
     * without it "Pixel 11" would be built from a Pixel 11 Pro listing.
     */
    const mine = items.filter((i) => i.title && !isRefinementChip(i.title) && isSameProduct(i.title, wanted));
    if (!mine.length) {
      console.log(`   ! no exact match for "${wanted}" — skipped`);
      continue;
    }
    /*
     * Rank by how well the title describes the product before anything else. A
     * case maker's listing once won on having a product_id and handed the phone
     * both its brand ("Casely") and a 3.7 rating that belonged to a phone case.
     */
    const lead = [...mine]
      .map((i) => ({ i, s: scoreTitle(i.title, wanted) }))
      .sort((x, y) => y.s - x.s
        || (y.i.product_id ? 1 : 0) - (x.i.product_id ? 1 : 0)
        || (y.i.product_images?.length ?? 0) - (x.i.product_images?.length ?? 0));
    const best = lead[0];
    // Keep the name the user asked for; listing titles carry colour and carrier.
    const p = toProduct(best.i, mine);
    p.name = wanted;
    p.slug = slugify(wanted);
    // The brand is in the name we were given; a listing title may not carry it.
    p.brand = wanted.split(' ')[0];
    // A rating only means something if it came from a listing of this product.
    if (best.s < 0.6) { p.rating = null; p.ratingCount = null; }
    products.push(p);
    console.log(`   ${wanted}  <- ${mine.length} listing(s)`);
  }
  console.log('');
} else {
  console.log('1. discovering products ...');
  const discovery = await runTasks('products', [{
    tag: `discover:${CATEGORY}`,
    payload: { keyword: KEYWORD, location_code: LOCATION, language_code: LANGUAGE, depth: DEPTH },
  }], state);

  const discovered = discovery.get(`discover:${CATEGORY}`);
  if (discovered?.error) { console.error(`  discovery failed: ${discovered.error}`); process.exit(1); }
  const rawItems = discovered?.result?.items ?? [];
  const grouped = groupIntoProducts(rawItems).slice(0, LIMIT);
  console.log(`   ${rawItems.length} listings -> ${grouped.length} distinct products\n`);
  products = grouped.map(({ lead, items }) => toProduct(lead, items));
}

if (!products.length) { console.log('Nothing to source.'); process.exit(0); }

/* ---- phase 2: prices per product ---- */

console.log('2. fetching prices per product ...');
const priceTasks = products.map((p) => ({
  tag: `price:${p.slug}`,
  payload: { keyword: p.name, location_code: LOCATION, language_code: LANGUAGE, depth: DEPTH },
}));
const priceResults = await runTasks('products', priceTasks, state);

function offersFrom(items, productName) {
  const out = [];
  const rejected = [];
  for (const it of items ?? []) {
    const price = typeof it.price === 'number' ? it.price : null;
    if (price === null || price <= 0) continue;
    if (MIN_PRICE && price < MIN_PRICE) { rejected.push([`${it.title} (under floor $${MIN_PRICE})`, price]); continue; }
    if (CONDITION_BAD.test(String(it.title ?? ''))) continue;
    if (!isSameProduct(it.title, productName)) { rejected.push([it.title, price]); continue; }
    const { head, sub } = splitSeller(it.seller);
    if (isInstalment(it.seller, price)) continue;
    const retailer = matchRetailer(it.seller);
    if (!retailer) continue;
    out.push({
      merchant: retailer.name,
      tier: retailer.tier,
      seller: retailer.tier === 3 ? sub : null,
      price,
      // old_price is the only RRP this endpoint exposes, and it is sparse.
      rrp: typeof it.old_price === 'number' && it.old_price > price ? it.old_price : null,
      currency: it.currency ?? 'USD',
      // No storefront URL exists in this response; a retailer search always resolves.
      url: retailer.search + encodeURIComponent(it.title ?? ''),
      title: it.title,
      rawSeller: it.seller,
      head,
    });
  }
  /*
   * Anchor on what Tier 1 and Tier 2 charge. A Galaxy A16 came back at $5.55
   * from Best Buy against $49.88 at Walmart — a listing that is real in the feed
   * but is not the price of a phone. Anything under a quarter of the highest
   * mainstream price is a carrier activation, an accessory that slipped the
   * title gate, or a data error, and it would become the headline "from" price.
   */
  const anchorPrices = out.filter((o) => o.tier <= 2).map((o) => o.price);
  if (anchorPrices.length) {
    const anchor = Math.max(...anchorPrices);
    const floor = anchor * 0.25;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].price < floor) { rejected.push([`${out[i].title} (below anchor $${anchor})`, out[i].price]); out.splice(i, 1); }
    }
  }

  // One row per merchant, cheapest kept.
  const best = new Map();
  for (const o of out.sort((a, b) => a.price - b.price)) if (!best.has(o.merchant)) best.set(o.merchant, o);
  return { offers: [...best.values()].sort((a, b) => a.price - b.price), rejected };
}

let totalOffers = 0;
for (const p of products) {
  const res = priceResults.get(`price:${p.slug}`);
  const items = res?.result?.items ?? [];
  // Listings from the category sweep count too — they were already paid for.
  const graded = offersFrom([...(p.discoveryOffers ?? []), ...items], p.name);
  p.offers = graded.offers;
  p.rejectedListings = graded.rejected;
  p.priceItemCount = items.length;
  // A better gid may appear in the per-product query than in the broad sweep.
  if (!p.gid) {
    const best = items.map((i) => ({ i, s: scoreTitle(i.title, p.name) }))
      .filter((x) => x.s > 0.5 && x.i.gid).sort((a, b) => b.s - a.s)[0];
    if (best) p.gid = best.i.gid;
  }
  if (!p.googleProductId) {
    const best = items.map((i) => ({ i, s: scoreTitle(i.title, p.name) }))
      .filter((x) => x.s > 0.5 && x.i.product_id).sort((a, b) => b.s - a.s)[0];
    if (best) p.googleProductId = best.i.product_id;
  }
  totalOffers += p.offers.length;
  delete p.discoveryOffers;
}
const totalRejected = products.reduce((n, p) => n + (p.rejectedListings?.length ?? 0), 0);
console.log(`   ${totalOffers} offers from allowed retailers across ${products.filter((p) => p.offers.length).length} products`);
console.log(`   ${totalRejected} listings rejected as accessories / wrong variant\n`);

/* ---- phase 3: reviews from tasks already paid for ---- */

let reviewCount = 0;
if (!NO_REVIEWS) {
  console.log('3. harvesting review gids (re-collect, free) ...');
  const tags = [
    ...(NAMES.length ? NAMES.map((n) => `find:${slugify(n)}`) : [`discover:${CATEGORY}`]),
    ...products.map((p) => `price:${p.slug}`),
  ];
  const recollected = await recollect('products', tags, state);
  for (const p of products) {
    if (p.gid) continue;
    for (const [, v] of recollected) {
      const best = (v.result?.items ?? []).map((i) => ({ i, s: scoreTitle(i.title, p.name) }))
        .filter((x) => x.s > 0.5 && x.i.gid).sort((a, b) => b.s - a.s)[0];
      if (best) { p.gid = best.i.gid; break; }
    }
  }
  const withGid = products.filter((p) => p.gid);
  console.log(`   ${withGid.length} of ${products.length} products have a gid`);

  if (withGid.length) {
    const revResults = await runTasks('reviews', withGid.map((p) => ({
      tag: `rev:${p.slug}`,
      payload: { gid: p.gid, location_code: LOCATION, language_code: LANGUAGE, depth: 20 },
    })), state);
    for (const p of withGid) {
      const r = revResults.get(`rev:${p.slug}`);
      /*
       * `result.title` is the product Google resolved the gid to. Checking it
       * against our own name is the only guard that the reviews belong to this
       * product at all — a gid harvested from a loose title match would
       * otherwise attach one phone's reviews to another.
       */
      const resolved = r?.result?.title ?? null;
      p.reviewsResolvedTitle = resolved;
      if (resolved && scoreTitle(resolved, p.name) < 0.6) {
        p.reviews = [];
        p.reviewsRejectedAs = resolved;
      } else {
        p.reviews = (r?.result?.items ?? []).map((x) => ({
          author: x.author ?? 'Anonymous',
          rating: x.rating?.value ?? null,
          title: x.title ?? null,
          body: x.review_text ?? null,
          sourceLabel: x.provided_by ?? null,
          postedAt: x.publication_date ?? null,
        })).filter((x) => x.body);
      }
      reviewCount += p.reviews.length;
    }
  }
  console.log(`   ${reviewCount} reviews retrieved\n`);
}

/* ---- report ---- */

fs.writeFileSync(OUT, JSON.stringify({ category: CATEGORY, keyword: KEYWORD, products }, null, 2));

for (const p of products) {
  console.log(`  ${p.name.slice(0, 62)}`);
  console.log(`     brand=${p.brand ?? '-'}  rating=${p.rating ?? '-'}${p.ratingCount ? `(${p.ratingCount})` : ''}  gtin=${p.gtin ?? 'n/a'}  gid=${p.gid ? 'yes' : 'no'}  reviews=${p.reviews?.length ?? 0}`);
  for (const o of p.offers) {
    console.log(`     $${String(o.price).padStart(9)}  T${o.tier} ${o.merchant.padEnd(22)}${o.rrp ? ` RRP $${o.rrp}` : ''}${o.seller ? ` [${o.seller}]` : ''}`);
  }
  if (!p.offers.length) console.log('     (no offers from allowed retailers)');
}

console.log(`\nrequests: ${spend.paid} paid, ${spend.free} free re-collects  ~$${(spend.paid * 0.001 * (PRIORITY === 2 ? 2 : 1)).toFixed(3)}`);
console.log(`report: ${OUT}`);

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write.'); process.exit(0); }

/* ---------------------------------------------------------------- write --- */

const catRes = await strapi(`/api/commerce-categories?filters[slug][$eq]=${CATEGORY}&pagination[pageSize]=1`);
const category = catRes?.data?.[0];
if (!category) { console.error(`No commerce-category with slug ${CATEGORY}`); process.exit(1); }

const merchantCache = new Map();
async function ensureMerchant(name) {
  if (merchantCache.has(name)) return merchantCache.get(name);
  const slug = slugify(name);
  const hit = await strapi(`/api/commerce-merchants?filters[slug][$eq]=${slug}&pagination[pageSize]=1`);
  let id = hit?.data?.[0]?.documentId;
  if (!id) {
    const made = await strapi('/api/commerce-merchants', {
      method: 'POST',
      body: JSON.stringify({ data: { name, slug, country: 'US', merchantStatus: 'active' } }),
    });
    id = made.data.documentId;
    console.log(`   + merchant ${name}`);
  }
  merchantCache.set(name, id);
  return id;
}

let madeP = 0, madeO = 0, madeR = 0, skippedExisting = 0, failedR = 0, failedO = 0;
let refreshed = 0, removedO = 0;
for (const p of products) {
  const slug = p.slug;
  /*
   * Skip rather than suffix. A suffixed duplicate was fine for a one-shot run,
   * but this script now gets re-run to resume after a failure, and a second
   * "google-pixel-9-2" product is worse than doing nothing.
   */
  const clash = await strapi(`/api/commerce-products?filters[slug][$eq]=${slug}&pagination[pageSize]=1`);
  let productId = clash?.data?.[0]?.documentId ?? null;
  if (productId && !REFRESH_OFFERS) { skippedExisting += 1; continue; }
  if (productId) {
    // Drop what this pipeline wrote before, keep anything from another source.
    const old = await strapi(`/api/commerce-offers?filters[product][slug][$eq]=${encodeURIComponent(slug)}&filters[source][$eq]=dataforseo-google-shopping&pagination[pageSize]=100&status=published`);
    for (const o of old?.data ?? []) {
      try { await strapi(`/api/commerce-offers/${o.documentId}`, { method: 'DELETE' }); removedO += 1; } catch { /* already gone */ }
    }
    refreshed += 1;
  }

  const created = productId ? null : await strapi('/api/commerce-products', {
    method: 'POST',
    body: JSON.stringify({ data: {
      name: p.name, slug, brand: p.brand,
      tags: [SITE_TAG],
      rating: p.rating, ratingCount: p.ratingCount,
      imageUrl: p.imageUrl, googleProductId: p.googleProductId,
      gtin: p.gtin,
      productStatus: 'active',
      categories: [category.documentId],
    } }),
  });
  if (created) { productId = created.data.documentId; madeP += 1; }

  for (const o of p.offers) {
    try {
    const merchantId = await ensureMerchant(o.merchant);
    await strapi('/api/commerce-offers', {
      method: 'POST',
      body: JSON.stringify({ data: {
        title: `${p.name} at ${o.merchant}${o.seller ? ` (${o.seller})` : ''}`.slice(0, 255),
        price: o.price, originalPrice: o.rrp, currency: o.currency,
        productUrl: o.url, availability: 'in_stock', condition: 'new',
        source: 'dataforseo-google-shopping',
        lastCheckedAt: new Date().toISOString(), status: 'active',
        product: productId, merchant: merchantId,
      } }),
    });
    madeO += 1;
    } catch (e) { failedO += 1; console.log(`   ! offer failed (${p.slug} / ${o.merchant}): ${String(e.message).slice(0, 90)}`); }
  }

  for (const r of (created ? p.reviews ?? [] : [])) {
    if (!r.rating) continue;
    try {
      await strapi('/api/commerce-reviews', {
        method: 'POST',
        body: JSON.stringify({ data: {
          authorName: String(r.author ?? 'Anonymous').slice(0, 90),
          rating: r.rating,
          // Strapi caps this field at 140 characters. Some syndicated reviews
          // put a whole paragraph in the title.
          title: r.title ? String(r.title).slice(0, 140) : null,
          body: r.body,
          source: r.sourceLabel ?? 'google-shopping',
          reviewStatus: 'approved', product: productId,
        } }),
      });
      madeR += 1;
    } catch (e) { failedR += 1; }
  }
}

console.log(`\ncreated ${madeP} products, ${madeO} offers, ${madeR} reviews.`);
if (skippedExisting) console.log(`${skippedExisting} product(s) already existed and were left alone.`);
if (refreshed) console.log(`refreshed offers on ${refreshed} existing product(s); removed ${removedO} superseded offer(s).`);
if (failedO || failedR) console.log(`${failedO} offer(s) and ${failedR} review(s) were rejected by Strapi and skipped.`);
