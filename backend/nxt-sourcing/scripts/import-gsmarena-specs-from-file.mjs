#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_DIR = resolve('/opt/strapi-cms-git/backend/nxt-sourcing');
loadEnv(resolve(APP_DIR, '.env.local'));

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const DEFAULT_FILE = resolve(APP_DIR, 'data/canonical-products/smartphone_specs.json');
const INPUT_FILE = resolve(APP_DIR, String(args.file || DEFAULT_FILE));
const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';
const WRITE = Boolean(args.write);
const OVERWRITE = Boolean(args.overwrite);
const LIMIT = positiveInt(args.limit, 0);
const ONLY_SLUG = text(args.slug);
/*
 * Create a product when the slug is not in Strapi yet, instead of reporting it
 * missing. A spec sheet often covers devices the catalogue has never carried —
 * 96 of 105 in the first GSMArena batch — and importing specs for the nine that
 * existed left the rest stranded.
 *
 * The new product carries only what the spec sheet actually knows: name, brand,
 * slug, category and the site tag. Offers, prices and images come from the
 * sourcing pipeline afterwards, which queries published products, so these are
 * created published rather than draft — a draft would be invisible to it.
 */
const CREATE_MISSING = Boolean(args.createMissing || args['create-missing']);
const NEW_CATEGORY = text(args.category || args.categorySlug);
const SITE_TAG = text(args.tag) || 'nxt-bargains';

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is not set in .env.local.');
if (!existsSync(INPUT_FILE)) fail(`Input file not found: ${INPUT_FILE}`);

let categoryDocumentId = null;
if (CREATE_MISSING) {
  if (!NEW_CATEGORY) fail('--create-missing requires --category=<slug or name>, e.g. --category=tablets');
  categoryDocumentId = await resolveCategory(NEW_CATEGORY);
  if (!categoryDocumentId) fail(`No active commerce category matches "${NEW_CATEGORY}".`);
}

const records = JSON.parse(readFileSync(INPUT_FILE, 'utf8'));
if (!Array.isArray(records)) fail(`Expected ${INPUT_FILE} to contain a JSON array.`);

const selectedRecords = records
  .filter((record) => isRecord(record) && (!ONLY_SLUG || text(record.product_slug) === ONLY_SLUG))
  .slice(0, LIMIT || undefined);

if (!selectedRecords.length) {
  console.log('No matching spec records found.');
  process.exit(0);
}

let processed = 0;
let created = 0;
let updated = 0;
let skipped = 0;
let missing = 0;
let errors = 0;

for (const record of selectedRecords) {
  processed += 1;
  const slug = text(record.product_slug);
  const title = text(record.product_title || record.clean_model || slug);
  const gsmarenaSpecs = normalizeFileSpecs(record);

  if (!slug) {
    skipped += 1;
    console.log(`- skipped ${title || `record ${processed}`}: missing product_slug`);
    continue;
  }

  if (!gsmarenaSpecs.specifications.length) {
    skipped += 1;
    console.log(`- skipped ${slug}: no specs_json.sections rows found`);
    continue;
  }

  try {
    let product = await getProductBySlug(slug);
    if (!product?.documentId && CREATE_MISSING) {
      if (!categoryDocumentId) {
        errors += 1;
        console.error(`! cannot create ${slug}: --category is required with --create-missing`);
        continue;
      }
      if (WRITE) {
        product = await createProduct({ slug, title, record });
        created += 1;
        console.log(`* created ${slug} in ${NEW_CATEGORY}`);
      } else {
        created += 1;
        console.log(`DRY RUN ${slug}: would create product in ${NEW_CATEGORY}`);
        continue;
      }
    }
    if (!product?.documentId) {
      missing += 1;
      console.log(`- missing in Strapi: ${slug}`);
      continue;
    }

    const existingSpecs = isRecord(product.specs) ? product.specs : {};
    if (!OVERWRITE && isRecord(existingSpecs.gsmarena)) {
      skipped += 1;
      console.log(`- skipped ${slug}: GSMArena specs already exist. Use --overwrite to replace.`);
      continue;
    }

    const nextSpecs = { ...existingSpecs };
    delete nextSpecs.technicalSpecs;
    delete nextSpecs.additionalInfo;
    Object.assign(nextSpecs, {
      gsmarena: gsmarenaSpecs,
      gsmarenaImportedAt: new Date().toISOString(),
      specSourceMerchant: 'GSMArena',
      specSourceUrl: gsmarenaSpecs.sourceUrl || gsmarenaSpecs.url,
      specImportedAt: new Date().toISOString(),
      source: existingSpecs.source || 'GSMArena',
    });

    if (WRITE) {
      await updateProduct(product.documentId, { specs: nextSpecs });
      updated += 1;
      console.log(`+ updated ${slug}: ${gsmarenaSpecs.specifications.length} GSMArena spec section(s)`);
    } else {
      console.log(`DRY RUN ${slug}: would import ${gsmarenaSpecs.specifications.length} GSMArena spec section(s)`);
    }
  } catch (error) {
    errors += 1;
    console.error(`! failed ${slug}: ${error.message}`);
  }
}

console.log(JSON.stringify({
  dryRun: !WRITE,
  file: INPUT_FILE,
  processed,
  created,
  updated,
  skipped,
  missing,
  errors,
}, null, 2));

if (!WRITE) console.log('No changes were saved. Add --write to update Strapi.');

function normalizeFileSpecs(record) {
  const specs = isRecord(record.specs_json) ? record.specs_json : {};
  const sections = Array.isArray(specs.sections) ? specs.sections : [];
  const specifications = sections
    .map((section) => {
      if (!isRecord(section)) return null;
      const category = text(section.section || section.category);
      const rows = Array.isArray(section.rows) ? section.rows : [];
      const entries = rows
        .map((row) => {
          if (!isRecord(row)) return null;
          const name = text(row.label || row.name);
          const value = text(row.value);
          return name && value ? { name, value } : null;
        })
        .filter(Boolean);

      return category && entries.length ? { category, specifications: entries } : null;
    })
    .filter(Boolean);

  return {
    source: text(specs.source || record.spec_source_name) || 'GSMArena',
    sourceUrl: text(specs.source_url || record.spec_source_url || record.gsmarena_url),
    sourceTitle: text(specs.source_title || record.clean_model || record.product_title),
    sourceImage: text(specs.source_image),
    cleanModel: text(specs.clean_model || record.clean_model),
    extractedAt: text(specs.extracted_at || record.extracted_at),
    matchStatus: text(record.status),
    matchConfidence: text(record.match_confidence),
    url: text(record.gsmarena_url || specs.source_url || record.spec_source_url),
    specifications,
  };
}

async function getProductBySlug(slug) {
  const params = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
    'populate[categories]': 'true',
  });
  const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi product slug lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data?.[0] || null;
}

/** Match a category by slug first, then by name, so either form works. */
async function resolveCategory(value) {
  for (const field of ['slug', 'name']) {
    const params = new URLSearchParams({
      [`filters[${field}][$eqi]`]: value,
      'pagination[pageSize]': '1',
    });
    const response = await fetch(`${STRAPI_URL}/api/commerce-categories?${params.toString()}`, {
      headers: strapiHeaders(), cache: 'no-store',
    });
    if (!response.ok) continue;
    const hit = (await response.json()).data?.[0];
    if (hit?.documentId) return hit.documentId;
  }
  return null;
}

/**
 * Brand is the first word of the model name — "OnePlus Pad 3 Pro" -> "OnePlus".
 * Crude, but the spec sheet has no brand column and a wrong brand is visible and
 * correctable, whereas a guessed one derived from specs would not be.
 */
function brandFromModel(model, title) {
  const source = text(model) || text(title);
  return source.split(/\s+/)[0] || null;
}

async function createProduct({ slug, title, record }) {
  const body = {
    data: {
      name: title,
      slug,
      brand: brandFromModel(record.clean_model, title),
      tags: [SITE_TAG],
      productStatus: 'active',
      categories: [categoryDocumentId],
    },
  };
  const response = await fetch(`${STRAPI_URL}/api/commerce-products`, {
    method: 'POST', headers: strapiHeaders(), body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Strapi create failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()).data;
}

async function updateProduct(documentId, data) {
  const response = await fetch(`${STRAPI_URL}/api/commerce-products/${encodeURIComponent(documentId)}`, {
    method: 'PUT',
    headers: strapiHeaders(),
    body: JSON.stringify({ data }),
  });
  if (!response.ok) throw new Error(`Strapi update failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function strapiHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      parsed[key] = argv[++index];
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  node scripts/import-gsmarena-specs-from-file.mjs --limit 5
  node scripts/import-gsmarena-specs-from-file.mjs --write --overwrite
  node scripts/import-gsmarena-specs-from-file.mjs --slug <product-slug> --write --overwrite

Options:
  --file <path>       JSON file to import. Defaults to data/canonical-products/smartphone_specs.json.
  --slug <slug>       Import one product by frontend slug.
  --limit <n>         Process only the first n matching JSON records.
  --write             Save specs into product.specs.gsmarena. Dry-run by default.
  --overwrite         Replace existing specs.gsmarena data.

Output:
  Converts specs_json.sections rows into product.specs.gsmarena.specifications
  for the storefront GSMArena Specs tab. Previously imported technicalSpecs and
  additionalInfo from this file are removed when the product is updated.
`);
}
