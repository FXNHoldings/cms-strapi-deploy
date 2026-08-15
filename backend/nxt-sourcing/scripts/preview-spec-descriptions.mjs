/**
 * Compose a product description from the specifications already stored on the
 * product, and print it. Read-only — this never writes.
 *
 *   node scripts/preview-spec-descriptions.mjs --limit=5
 *   node scripts/preview-spec-descriptions.mjs --category=laptops --limit=3
 *   node scripts/preview-spec-descriptions.mjs --slug=<slug>
 *
 * Every clause is assembled from a spec row that was imported from Google's
 * product data. Nothing is inferred, rated or embellished: there are no claims
 * about how good the battery is, how the camera performs, or whether the price
 * is fair, because no such field exists to source them from.
 *
 * This is deliberately a formatter, not a writer. A model asked to describe
 * "Google Pixel 10 Pro XL" from its own knowledge would produce fluent prose
 * containing assertions this catalogue cannot support — which is the failure
 * mode worth avoiding on a page that carries a buy button.
 *
 * Where the specs are too thin to say anything useful, it returns nothing rather
 * than padding.
 */
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const CATEGORY = flag('category', null);
const SLUG = flag('slug', null);
const LIMIT = Number(flag('limit', 5));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';

/**
 * Spec keys grouped into the sentences they belong to, in reading order.
 * The first key present in a group wins, so aliases can be listed together.
 */
const CLAUSES = [
  { lead: 'display', keys: ['Screen Size', 'Display Size', 'Display Resolution', 'Resolution', 'Display Type', 'Refresh Rate'] },
  { lead: 'platform', keys: ['Operating System', 'Processor', 'Processor Model', 'Chipset', 'CPU'] },
  { lead: 'memory', keys: ['RAM', 'Memory', 'Storage Capacity', 'Internal Storage', 'Hard Drive Capacity'] },
  { lead: 'power', keys: ['Battery Life', 'Battery Capacity', 'Battery'] },
  { lead: 'camera', keys: ['Rear Camera Resolution', 'Front Camera Resolution', 'Camera Resolution', 'Megapixels'] },
  { lead: 'connectivity', keys: ['Connectivity', 'Wireless Technology', 'SIM Support', 'Assistant Support', 'Bluetooth Version'] },
  { lead: 'physical', keys: ['Weight', 'Colour', 'Color', 'Water Resistance', 'Material'] },
];

const SKIP_KEYS = new Set(['source', 'importedAt', 'sourceImageUrl', 'features', 'technicalSpecs', 'gsmarena']);

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = Array.isArray(v) ? v.join(', ') : String(v);
  const t = s.replace(/\s+/g, ' ').trim();
  return t && t.toLowerCase() !== 'n/a' && t !== '-' ? t : null;
};

/** Human phrase for one spec, e.g. "a 6.8-inch screen". */
function phraseFor(key, value) {
  const v = clean(value);
  if (!v) return null;
  const k = key.toLowerCase();
  if (k.includes('screen size') || k.includes('display size')) return `has a ${v} display`;
  if (k.includes('refresh')) return `has a ${v} refresh rate`;
  if (k.includes('resolution') && k.includes('camera')) {
    // "Rear Camera Resolution: 48 MP rear camera" would otherwise read "camera camera".
    const front = k.includes('front') ? 'front' : 'rear';
    const val = v.replace(/\s*(rear|front)?\s*camera/ig, '').trim();
    return `has a ${val} ${front} camera`;
  }
  if (k.includes('resolution')) return `has a ${v} resolution`;
  if (k.includes('operating system')) return `runs ${v}`;
  if (k.includes('processor') || k.includes('chipset') || k === 'cpu') return `is powered by the ${v}`;
  if (k === 'ram' || k.includes('memory')) return `has ${v} of memory`;
  if (k.includes('storage') || k.includes('hard drive')) return `has ${v} of storage`;
  if (k.includes('battery life')) return `rated for ${v} of battery life`;
  if (k.includes('battery')) return `has a ${v} battery`;
  if (k.includes('weight')) return `weighs ${v}`;
  if (k.includes('water')) return `carries ${v} water resistance`;
  if (k.includes('assistant')) return `works with ${v}`;
  if (k.includes('sim')) return `supports ${v}`;
  if (k.includes('connectivity') || k.includes('wireless')) return `connects over ${v}`;
  if (k.includes('colour') || k === 'color') return `comes in ${v}`;
  if (k.includes('material')) return `is built from ${v}`;
  // No known phrasing: leave it out rather than emit "Display Type: OLED" mid-sentence.
  return null;
}

function describe(product) {
  const specs = product.specs;
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) return null;

  const lookup = (keys) => {
    for (const key of keys) {
      const match = Object.keys(specs).find((k) => k.toLowerCase() === key.toLowerCase());
      if (match && !SKIP_KEYS.has(match)) {
        const phrase = phraseFor(match, specs[match]);
        if (phrase) return phrase;
      }
    }
    return null;
  };

  const brand = clean(product.brand);
  const SINGULAR = {
    'smart phones': 'smartphone', smartwatches: 'smartwatch', tablets: 'tablet',
    laptops: 'laptop', headphones: 'pair of headphones', 'smart tvs': 'smart TV',
    'smart speakers': 'smart speaker', 'smart cameras': 'smart camera',
    'video doorbells': 'video doorbell', 'smart door locks': 'smart lock',
    'smart light bulbs': 'smart bulb', 'smart plugs': 'smart plug',
    'raspberry pi': 'Raspberry Pi board',
  };
  const rawCategory = clean(product.categories?.[0]?.name)?.replace(/ AU$/, '').toLowerCase();
  const category = rawCategory ? (SINGULAR[rawCategory] ?? rawCategory.replace(/s$/, '')) : null;

  const parts = CLAUSES.map((c) => lookup(c.keys)).filter(Boolean);
  // Two facts is the floor. Below that it reads as a stub, and a stub is worse
  // than leaving the field empty for a page to handle.
  if (parts.length < 2) return null;

  const article = brand && /^[aeiou]/i.test(brand) ? 'an' : 'a';
  const opener = brand && category
    ? `The ${product.name} is ${article} ${brand} ${category}.`
    : `The ${product.name}.`;

  // Each part is already a predicate, so sentences are "It <a> and <b>."
  const sentences = [opener];
  for (let i = 0; i < parts.length; i += 2) {
    sentences.push(`It ${parts.slice(i, i + 2).join(' and ')}.`);
  }
  return sentences.join(' ').replace(/\s+/g, ' ').replace(/ \./g, '.');
}

/* --------------------------------------------------------------------- main */

const q = new URLSearchParams({ 'pagination[pageSize]': '400', status: 'published' });
q.append('filters[tags][$containsi]', 'nxt-bargains');
if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
if (SLUG) q.append('filters[slug][$eq]', SLUG);
q.append('populate[categories][fields][0]', 'name');

const res = await fetch(`${STRAPI_URL}/api/commerce-products?${q}`, {
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});
const all = (await res.json()).data ?? [];

const candidates = SLUG ? all : all.filter((p) => !p.description);
let shown = 0, skipped = 0;

for (const p of candidates) {
  const text = describe(p);
  if (!text) { skipped += 1; continue; }
  if (shown >= LIMIT) break;
  shown += 1;
  const specCount = Object.keys(p.specs ?? {}).filter((k) => !SKIP_KEYS.has(k)).length;
  console.log(`\n── ${p.name}`);
  console.log(`   ${specCount} specs available, ${text.length} chars generated`);
  console.log(`\n   ${text}\n`);
}

console.log(`\nshown ${shown}; ${skipped} candidate(s) had too few specs to describe honestly.`);
