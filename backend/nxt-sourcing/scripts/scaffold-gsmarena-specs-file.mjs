/**
 * Build an empty spec file for `import-gsmarena-specs-from-file.mjs` to consume,
 * pre-filled with the product identity so only the specs need supplying.
 *
 *   node scripts/scaffold-gsmarena-specs-file.mjs
 *   node scripts/scaffold-gsmarena-specs-file.mjs --category=tablets --out=/tmp/tablets.json
 *
 * `product_slug` is the join key the importer matches on, so generating it from
 * Strapi rather than typing it removes the one failure that silently drops a
 * record — a slug that looks right but does not match.
 *
 * `clean_model` is the product name with retail noise stripped: capacity,
 * connectivity and words like "Smartphone" or "Unlocked". That is the string a
 * specs source is likely to index by, since GSMArena lists "Samsung Galaxy S25
 * Ultra", not "Samsung Galaxy S25 Ultra 256GB". It is a suggestion, not a
 * result — correct it where the guess is wrong.
 *
 * Deliberately written to a *.template.json name. The importer defaults to
 * smartphone_specs.json, and a file full of empty `sections` would import
 * cleanly while writing nothing useful; the distinct name prevents that from
 * happening by accident.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const CATEGORY = flag('category', 'smart-phones');
const OUT = flag('out', path.join(ROOT, 'data/canonical-products', `${CATEGORY.replace(/-/g, '_')}_specs.template.json`));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';

/** Retail packaging noise that a specs database will not have in its model name. */
function cleanModel(name) {
  return String(name)
    .replace(/\b\d+\s?(gb|tb)\b/gi, '')                       // capacity
    .replace(/\b(wi-?fi(\s*\+\s*cellular)?|cellular|lte|5g|4g|bluetooth|gps(\s*\+\s*cellular)?)\b/gi, '')
    .replace(/\b(unlocked|factory unlocked|smartphone|smart phone|prepaid|dual sim|sim free)\b/gi, '')
    .replace(/\s*\(\s*\)\s*/g, ' ')                            // emptied brackets
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,\-]+$/, '')
    .trim();
}

const q = new URLSearchParams({ 'pagination[pageSize]': '1000', status: 'published' });
q.append('filters[tags][$containsi]', 'nxt-bargains');
q.append('filters[categories][slug][$eq]', CATEGORY);
q.append('fields[0]', 'name');
q.append('fields[1]', 'slug');
q.append('fields[2]', 'brand');

const res = await fetch(`${STRAPI_URL}/api/commerce-products?${q}`, {
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});
if (!res.ok) { console.error(`Strapi ${res.status}`); process.exit(1); }
const products = (await res.json()).data ?? [];

if (!products.length) { console.error(`No published products in category "${CATEGORY}".`); process.exit(1); }

const records = products
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((p) => ({
    product_slug: p.slug,
    product_title: p.name,
    clean_model: cleanModel(p.name),
    gsmarena_url: '',
    status: 'pending',
    match_confidence: '',
    specs_json: {
      source: 'GSMArena',
      source_url: '',
      extracted_at: '',
      // Fill these in. Each section becomes one table on the product page:
      //   { "section": "Display", "rows": [ { "label": "Size", "value": "6.9 inches" } ] }
      // A row missing either label or value is dropped by the importer.
      sections: [],
    },
  }));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(records, null, 2)}\n`);

console.log(`category : ${CATEGORY}`);
console.log(`products : ${records.length}`);
console.log(`written  : ${OUT}\n`);
console.log('sample record:');
console.log(JSON.stringify(records[0], null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
console.log(`\nFill in specs_json.sections, then:`);
console.log(`  node scripts/import-gsmarena-specs-from-file.mjs --file=${OUT} --limit=3`);
console.log(`  node scripts/import-gsmarena-specs-from-file.mjs --file=${OUT} --write`);
