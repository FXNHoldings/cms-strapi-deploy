/**
 * Find merchant offers attached to the wrong product. READ-ONLY by default.
 *
 *   node scripts/audit-offer-matches.mjs                 # report
 *   node scripts/audit-offer-matches.mjs --site=nxtsmarthome.com.au
 *   node scripts/audit-offer-matches.mjs --delete        # remove the failures
 *
 * Why not title similarity: it does not work for this. Measured on a real case,
 * "Google Pixel 6 Pro" scores 0.55 against "Google Pixel 10 Pro Fold 256GB"
 * because they share google/pixel/pro/unlocked/smartphone — high enough to pass
 * any sane threshold, while being a different phone at a third of the price.
 * Only a Samsung Galaxy Z Fold5 on the same product scored low enough (0.15) to
 * be caught. Bag-of-words measures topic, and these offers are all on topic.
 *
 * What actually separates them is what data/canonical-products/README.md already
 * says to score on: required terms and excluded terms.
 *
 *   1. MODEL NUMBERS. "10" in "Pixel 10 Pro Fold" is the whole difference
 *      between a $799 phone and a $319 one. Every standalone number and
 *      alphanumeric model token in the product name must appear in the offer.
 *   2. VARIANT WORDS. Fold / XL / Max / Plus / Ultra / Mini / Pro separate
 *      products in the same line, so a variant named in the product must be
 *      present, and a *different* variant in the offer is disqualifying.
 *   3. CONDITION. Renewed, refurbished, restored and pre-owned are different
 *      goods at different prices; a listing for one must not price a new item.
 *
 * Storage capacity is deliberately NOT required: 256GB is a variant to split
 * later, not a different product, and requiring it would delete legitimate
 * offers that omit it from the title.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const DELETE = args.includes('--delete');
const SITE = flag('site', null);
const LIMIT = Number(flag('limit', Infinity));
/*
 * Which rule classes --delete may act on. Defaults to the two that survived a
 * random-sample precision check: condition and accessory. The model and variant
 * rules find real mismatches but also flag "ROG Strix G16" for missing "16" and
 * read "Core Ultra" as a product variant, so at ~70% precision they are a review
 * queue, not something to run deletions from.
 */
const ONLY = (flag('only', 'condition,accessory') || '').split(',').map((x) => x.trim()).filter(Boolean);
const OUT = flag('out', path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'reports', 'offer-match-audit.json'));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';

/* Different goods, not a cheaper instance of the same one. */
const CONDITION_TERMS = [
  'renewed', 'refurbished', 'refurb', 'restored', 'pre-owned', 'preowned',
  'used', 'open box', 'for parts', 'parts only', 'cracked', 'damaged',
];

/* Variants that separate products within one line. */
const VARIANT_TERMS = ['fold', 'flip', 'xl', 'max', 'plus', 'ultra', 'mini', 'pro', 'lite', 'se'];

/*
 * Accessories, restricted to terms that cannot mean the product itself.
 *
 * "case", "band", "strap" and "cover" were removed after they flagged a third
 * of the catalogue: an Apple Watch is legitimately sold as "40mm Aluminum Case
 * with Sport Band", where the case IS the watch. Only phrases that describe a
 * separate article survive here.
 */
const ACCESSORY_TERMS = [
  'screen protector', 'tempered glass', 'lcd display', 'digitizer',
  'replacement screen', 'carrying case', 'protective case', 'charging cable',
  'for parts', 'parts only', 'stylus tip',
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);
const has = (hay, term) => norm(hay).includes(norm(term));

/** Model tokens: standalone numbers and alphanumeric codes that identify the
 *  generation or model. Storage sizes are excluded — see the header. */
function modelTokens(name) {
  const out = new Set();
  for (const w of words(name)) {
    if (/^\d+(gb|tb|mb)$/.test(w)) continue;           // capacity, not model
    if (/^(19|20)\d{2}$/.test(w)) continue;            // a year is not a model
    if (/^\d{1,4}$/.test(w)) out.add(w);               // 6, 10, 400
    else if (/^[a-z]+\d+[a-z0-9]*$/.test(w) && w.length <= 12) out.add(w); // s25, wh1000xm5
  }
  return [...out];
}

function evaluate(productName, offerTitle) {
  const reasons = [];
  if (!offerTitle) return { verdict: 'unknown', reasons: ['offer has no title'] };

  for (const c of CONDITION_TERMS) {
    if (has(offerTitle, c) && !has(productName, c)) reasons.push(`condition: "${c}"`);
  }
  for (const a of ACCESSORY_TERMS) {
    if (has(offerTitle, a) && !has(productName, a)) reasons.push(`accessory: "${a}"`);
  }

  /*
   * Require the PRIMARY model token only — the first number in the product
   * name, which is the generation. Demanding every token deletes good offers:
   * Best Buy lists "Zenbook A14 Laptop 14.0 OLED" without the UX3407QA SKU, and
   * writes 14.0 where the product says 14. Trailing .0 is normalised for that
   * reason. The generation number is what separates a Pixel 6 from a Pixel 10.
   */
  const need = modelTokens(productName);
  // Ordinals are the same model: "Apple Watch SE 3rd Gen" is the SE 3. Without
  // this, every listing that spells the generation out is flagged as the wrong
  // product.
  const offerWords = new Set(
    words(offerTitle).map((w) => w.replace(/\.0$/, '').replace(/^(\d+)(st|nd|rd|th)$/, '$1')),
  );
  const primary = need.find((t) => /^\d+$/.test(t));
  if (primary && !offerWords.has(primary)) reasons.push(`wrong model: product is "${primary}", offer is not`);

  for (const v of VARIANT_TERMS) {
    const inProduct = words(productName).includes(v);
    const inOffer = words(offerTitle).includes(v);
    if (inProduct && !inOffer) reasons.push(`missing variant: "${v}"`);
  }

  return { verdict: reasons.length ? 'mismatch' : 'ok', reasons };
}

/* ------------------------------------------------------------------- api -- */

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init.headers ?? {}) },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function readProducts() {
  const all = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ 'pagination[page]': String(page), 'pagination[pageSize]': '50' });
    q.append('fields[0]', 'name'); q.append('fields[1]', 'slug');
    q.append('populate[offers][fields][0]', 'title');
    q.append('populate[offers][fields][1]', 'price');
    q.append('populate[offers][fields][2]', 'source');
    q.append('populate[offers][populate][merchant][fields][0]', 'name');
    q.append('populate[site][fields][0]', 'domain');
    if (SITE) q.append('filters[site][domain][$eq]', SITE);
    const json = await api(`/api/commerce-products?${q}`);
    all.push(...(json?.data ?? []));
    if (page >= (json?.meta?.pagination?.pageCount ?? 1)) break;
  }
  return all;
}

/* ------------------------------------------------------------------ main -- */

const products = (await readProducts()).slice(0, LIMIT);
const findings = [];
let offersSeen = 0;

for (const p of products) {
  for (const o of p.offers ?? []) {
    offersSeen++;
    const { verdict, reasons } = evaluate(p.name, o.title);
    if (verdict === 'mismatch') {
      const joined = reasons.join(' ');
      const ruleClass = joined.includes('condition:') ? 'condition'
        : joined.includes('accessory:') ? 'accessory'
        : joined.includes('wrong model') ? 'model'
        : joined.includes('missing variant') ? 'variant' : 'other';
      findings.push({
        ruleClass,
        productSlug: p.slug, productName: p.name, site: p.site?.domain ?? null,
        offerDocumentId: o.documentId, offerTitle: o.title, price: o.price,
        merchant: o.merchant?.name ?? null, source: o.source ?? null, reasons,
      });
    }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), site: SITE, products: products.length, offersSeen, mismatches: findings.length, findings }, null, 2)}\n`);

console.log(`products : ${products.length}${SITE ? ` [site=${SITE}]` : ''}`);
console.log(`offers   : ${offersSeen}`);
console.log(`mismatch : ${findings.length}  (${((findings.length / Math.max(offersSeen, 1)) * 100).toFixed(1)}%)\n`);

const bySource = findings.reduce((a, f) => ((a[f.source ?? '(none)'] = (a[f.source ?? '(none)'] ?? 0) + 1), a), {});
console.log('by source:');
for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${String(s).padEnd(28)} ${n}`);

console.log('\nworst offenders:');
for (const f of findings.slice(0, 12)) {
  console.log(`  ${f.productName.slice(0, 46)}`);
  console.log(`    $${f.price} ${f.merchant ?? '?'} — ${String(f.offerTitle).slice(0, 58)}`);
  console.log(`    ${f.reasons.join('; ')}`);
}
console.log(`\nreport: ${OUT}`);

if (!DELETE) {
  console.log('\nRead-only. Re-run with --delete to remove these offers.');
} else {
  const deletable = findings.filter((f) => ONLY.includes(f.ruleClass));
  console.log(`\n--delete limited to rule classes [${ONLY.join(', ')}]: ${deletable.length} of ${findings.length}`);
  let removed = 0;
  for (const f of deletable) {
    if (!f.offerDocumentId) continue;
    try { await api(`/api/commerce-offers/${f.offerDocumentId}`, { method: 'DELETE' }); removed++; }
    catch (err) { console.log(`  FAILED ${f.offerDocumentId}: ${err.message}`); }
  }
  console.log(`\ndeleted ${removed} offer(s).`);
}
