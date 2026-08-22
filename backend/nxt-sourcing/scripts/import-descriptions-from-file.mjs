/**
 * Import product descriptions from a prepared spreadsheet or JSON file.
 *
 *   node scripts/import-descriptions-from-file.mjs --file=<path>            # dry run
 *   node scripts/import-descriptions-from-file.mjs --file=<path> --write
 *   ... --overwrite   --limit=10   --min-confidence=high
 *
 * The file needs a `slug` column and a `description` column. Anything else is
 * ignored, which is deliberate: a sheet may also carry specifications, sources
 * and a confidence rating, and those are not imported here. Specifications in
 * particular belong to the specs importer, where they are structured rather
 * than a wall of text.
 *
 * Safety properties, because this writes editorial copy to live products:
 *
 *   - Dry run by default. Nothing is written without --write.
 *   - A product that already has a description is skipped unless --overwrite.
 *     Filling a blank is additive; replacing existing copy is a decision.
 *   - Rows whose slug matches no product are reported, never created. A typo in
 *     a slug should surface as a skipped row, not a new empty product.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const OVERWRITE = args.includes('--overwrite');
const FILE = flag('file', null);
const LIMIT = Number(flag('limit', Infinity));
const MIN_CONFIDENCE = flag('min-confidence', null);   // 'high' | 'medium' | 'low'
const SITE_TAG = flag('site-tag', 'nxt-bargains');

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

if (!FILE) { console.error('usage: --file=<path.json> [--write] [--overwrite]'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.error(`No such file: ${FILE}`); process.exit(1); }

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

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

/* --------------------------------------------------------------------- main */

const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (!Array.isArray(rows)) { console.error('Expected a JSON array of rows.'); process.exit(1); }

const wanted = rows
  .map((r) => ({ slug: clean(r.slug), description: clean(r.description), confidence: clean(r.confidence).toLowerCase() }))
  .filter((r) => r.slug && r.description)
  .filter((r) => {
    if (!MIN_CONFIDENCE) return true;
    const need = CONFIDENCE_RANK[MIN_CONFIDENCE.toLowerCase()] ?? 0;
    return (CONFIDENCE_RANK[r.confidence] ?? 0) >= need;
  })
  .slice(0, LIMIT);

async function allProducts() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const q = new URLSearchParams({
      'pagination[page]': String(page), 'pagination[pageSize]': '200', status: 'published',
    });
    q.append('filters[tags][$containsi]', SITE_TAG);
    for (const [i, f] of ['slug', 'name', 'description'].entries()) q.append(`fields[${i}]`, f);
    const res = await strapi(`/api/commerce-products?${q}`);
    const batch = res?.data ?? [];
    out.push(...batch);
    if (page >= (res?.meta?.pagination?.pageCount ?? 1) || !batch.length) break;
  }
  return out;
}

const bySlug = new Map((await allProducts()).map((p) => [p.slug, p]));

const plan = { write: [], skipExisting: [], notFound: [] };
for (const row of wanted) {
  const product = bySlug.get(row.slug);
  if (!product) { plan.notFound.push(row); continue; }
  const existing = clean(String(product.description ?? '').replace(/<[^>]*>/g, ' '));
  if (existing && !OVERWRITE) { plan.skipExisting.push(row); continue; }
  plan.write.push({ ...row, documentId: product.documentId, name: product.name, replacing: Boolean(existing) });
}

console.log(`file rows        : ${rows.length}`);
console.log(`usable rows      : ${wanted.length}${MIN_CONFIDENCE ? ` (confidence >= ${MIN_CONFIDENCE})` : ''}`);
console.log(`to write         : ${plan.write.length}${OVERWRITE ? ` (${plan.write.filter((p) => p.replacing).length} replacing existing)` : ''}`);
console.log(`skipped, has one : ${plan.skipExisting.length}`);
console.log(`slug not found   : ${plan.notFound.length}`);
for (const r of plan.notFound.slice(0, 10)) console.log(`    ? ${r.slug}`);
console.log(`mode             : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);

if (!plan.write.length) process.exit(0);
for (const p of plan.write.slice(0, 5)) {
  console.log(`  ${p.slug.slice(0, 46).padEnd(48)} ${p.description.length}ch  [${p.confidence || 'n/a'}]`);
}
if (plan.write.length > 5) console.log(`  ... and ${plan.write.length - 5} more`);

if (!WRITE) { console.log('\nDry run — nothing written.'); process.exit(0); }

let stored = 0; let failed = 0;
for (const p of plan.write) {
  try {
    await strapi(`/api/commerce-products/${p.documentId}?status=published`, {
      method: 'PUT', body: JSON.stringify({ data: { description: p.description } }),
    });
    stored += 1;
    if (stored % 25 === 0) process.stdout.write(`  written ${stored}/${plan.write.length}\r`);
  } catch (e) {
    failed += 1;
    console.log(`  FAILED ${p.slug}: ${String(e.message).slice(0, 120)}`);
  }
}
process.stdout.write('\n');
console.log(`\nwrote ${stored} description(s); ${failed} failed.`);
