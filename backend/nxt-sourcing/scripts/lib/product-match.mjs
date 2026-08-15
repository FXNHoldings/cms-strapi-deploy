/**
 * Product identity matching, shared by the sourcing scripts.
 *
 * Extracted verbatim from source-category-pipeline.mjs, where every rule was
 * added in response to a specific wrong price reaching a product page: an A26
 * sold as an S26, a base M5 quoting an M5 Pro, a $29.99 phone case as an $800
 * Pixel's headline price, a carrier's $8.20 monthly instalment as a handset.
 *
 * Anything that resolves a product by NAME needs this. Lookups keyed on a
 * googleProductId do not -- the sellers returned are, by construction, sellers
 * of that product.
 */


const ACCESSORY = /\b(case|cover|skin|sleeve|pouch|holster|screen protector|tempered glass|charger|cable|adapter|dock|mount|holder|stand|stylus|lens|film|bumper|grip|strap|band|kit for|for [a-z]+ \d)\b/i;


const ENCUMBERED = /\b(missing|cracked|damaged|broken|faulty|spares|salvage|as-?is|parts only|bad esn|blacklist|past_?due|icloud ?locked|activation ?locked|financed|no power|screen burn|does ?n[o']?t work|can'?t activate|cannot activate|carrier locked|network locked|sim locked|bad imei)\b/i;


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


const DESCRIPTOR_GROUPS = [
  ['battery', 'poe', 'plug in', 'plugin', 'hardwired', 'wired'],
  ['amoled', 'microled', 'solar'],
  ['starter kit', 'bridge'],
  ['matter'],
];


const CONDITION_BAD = /refurb|renewed|restored|pre-?owned|\bused\b|open box|for parts|grade [abc]\b/i;


const CHIP_TAIL = /\b(smartphones|phones|laptops|tablets|headphones|earbuds|speakers|cameras|doorbells|locks|bulbs|plugs|watches|tvs)\s*$/i;

const CHIP_HEAD = /^(unlocked|best|top|new|cheap|refurbished|android|smart|wireless|budget)\b/i;


const STOP = new Set(['the', 'and', 'with', 'for', 'new', 'sale', 'unlocked', 'smartphone', 'phone']);


const normalise = (s) => normaliseSku(s)
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();


function normaliseSku(raw) {
  return skuNorm(raw).replace(/([a-z])(\d)/g, '$1 $2');   // "flip7" -> "flip 7"
}

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

function capacityOf(raw) {
  const m = skuNorm(raw).match(/\b(\d+)(gb|tb)\b/);
  return m ? `${m[1]}${m[2]}` : null;
}

function caseSizeOf(raw) {
  const m = skuNorm(raw).match(/\b(\d{2})\s*mm\b/);
  return m ? `${m[1]}mm` : null;
}

function screenSizeOf(raw) {
  const m = skuNorm(raw).match(/\b(\d{2,3}(?:\.\d)?)inch\b/);
  return m ? `${m[1]}inch` : null;
}

function connectivityOf(raw) {
  const t = String(raw || '').toLowerCase();
  if (/\b(lte|cellular|4g|5g)\b/.test(t)) return 'cellular';
  if (/\b(bluetooth|wi-?fi|gps only|gps)\b/.test(t)) return 'basic';
  return null;
}

function chipTierOf(raw) {
  const s = normaliseSku(raw);
  const m = s.match(/\bm\s?\d\s*(pro|max|ultra)\b/);
  if (m) return m[1];
  return /\bm\s?\d\b/.test(s) ? 'base' : null;
}

function yearOf(raw) {
  const m = skuNorm(raw).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

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

function modelTokensMatch(want, have) {
  for (const w of want) {
    if (have.has(w)) continue;
    if (/^\d+$/.test(w) && [...have].some((h) => h.endsWith(w))) continue;
    return false;
  }
  return true;
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

function descriptorOf(raw, group) {
  const s = normaliseSku(raw);
  return group.find((w) => new RegExp(`\\b${w.replace(/ /g, '[ -]')}\\b`).test(s)) ?? null;
}

function scoreTitle(candidate, reference) {
  const a = new Set(normalise(candidate).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
  const b = new Set(normalise(reference).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const w of b) if (a.has(w)) hits += 1;
  return hits / b.size;
}

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

function isRefinementChip(title) {
  const t = String(title || '');
  return CHIP_TAIL.test(t) && CHIP_HEAD.test(t);
}

/**
 * The name to SEARCH Google Shopping with, as opposed to the name to match on.
 *
 * Searching "OnePlus Ace 6 512GB" returns little or nothing: retailers title
 * their listings "OnePlus Ace 6" and put the capacity in a variant selector, so
 * the capacity in the query only narrows the result set to noise. Dropping it
 * finds the product; "OnePlus 15R 512G" behaves the same way.
 *
 * This is safe precisely because it is only the query. isSameProduct still
 * compares the listing against the product's FULL name, so a 256GB listing is
 * still rejected for a 512GB product -- the capacity gate reads productName, not
 * this string. Search wide, match narrow.
 *
 * Only storage units are removed. "5G" is left alone: it is a radio, not a
 * capacity, which is why a bare-G suffix is stripped only for the values
 * storage actually comes in.
 */
const STORAGE_CAPACITY = /\b\d+\s?(?:gb|tb)\b|\b(?:128|256|512|1024)\s?g\b/gi;

function searchKeyword(name) {
  const stripped = String(name || '').replace(STORAGE_CAPACITY, ' ').replace(/\s{2,}/g, ' ').trim();
  // Never hand back an empty or near-empty query; fall back to the full name.
  return stripped.length >= 3 ? stripped : String(name || '').trim();
}

export {
  normaliseSku,
  skuNorm,
  searchKeyword,
  capacityOf,
  caseSizeOf,
  screenSizeOf,
  connectivityOf,
  chipTierOf,
  yearOf,
  modelTokens,
  modelTokensMatch,
  variantSet,
  descriptorOf,
  scoreTitle,
  isSameProduct,
  isRefinementChip,
};
