#!/usr/bin/env node
/**
 * Import products from an Apify dataset into Strapi (`bls-product`).
 *
 * Apify dataset items are expected to have at least:
 *   { name, url, asin, price: { value, currency }, stars, reviewsCount, thumbnailUrl,
 *     categoryName, subcategories?: [{ categoryName }], ... }
 *
 * Maps to BlsProduct as:
 *   name                  ← name
 *   slug                  ← slugify(name)
 *   asin                  ← asin
 *   sourceUrl             ← url
 *   sourceMerchant        ← 'amazon' (Apify Amazon scraper)
 *   primaryAffiliateUrl   ← url with ?tag=AMAZON_AFFILIATE_TAG appended
 *   currentPrice          ← price.value
 *   currency              ← '$' → 'USD' (etc.)
 *   rating                ← stars * 2  (Apify gives 5-star, BLS schema uses 0-10)
 *   ratingCount           ← reviewsCount
 *   primaryImage          ← upload(thumbnailUrl)
 *   keyFeatures           ← [categoryName, ...subcategories.categoryName]
 *
 * Idempotent: dedupes by sourceUrl. Re-running updates rather than duplicating.
 *
 * Required env:
 *   STRAPI_URL              default: http://127.0.0.1:8888
 *   STRAPI_TOKEN            REQUIRED  Strapi → Settings → API Tokens (full access)
 *   APIFY_DATASET_ID        REQUIRED unless APIFY_RUN_ID is set, or unless you
 *                                    pass the dataset ID/URL as a CLI argument.
 *   APIFY_RUN_ID            Optional alternative — pass an Apify *run* ID and
 *                                    we resolve its default dataset.
 *
 * Optional env:
 *   APIFY_TOKEN             only if the dataset is private — items GET is
 *                           usually public on shared datasets.
 *   AMAZON_AFFILIATE_TAG    e.g. unitradeco-20
 *   BLS_PRODUCT_CATEGORY    Slug of a bls-product-category to assign to every
 *                           imported product. If the slug doesn't exist the
 *                           script aborts unless CREATE_CATEGORY=1.
 *   BLS_PRODUCT_CATEGORY_NAME
 *                           Display name to use when CREATE_CATEGORY=1 and
 *                           the slug isn't already in Strapi (defaults to a
 *                           Title Cased version of the slug).
 *   CREATE_CATEGORY=1       Auto-create the target category if missing.
 *   DRY_RUN=1               No Strapi writes, just print what would happen.
 *   LIMIT                   Cap number of items processed (for testing).
 *
 * Usage:
 *   # via env var
 *   STRAPI_TOKEN=... APIFY_DATASET_ID=bwcrQnlSrfo8WUzxz \
 *     AMAZON_AFFILIATE_TAG=unitradeco-20 \
 *     node scripts/import-products-from-apify.mjs
 *
 *   # via CLI arg — accepts dataset ID or full API URL
 *   node scripts/import-products-from-apify.mjs bwcrQnlSrfo8WUzxz
 *   node scripts/import-products-from-apify.mjs https://api.apify.com/v2/datasets/bwcrQnlSrfo8WUzxz/items
 *
 *   # via run ID (resolves run → default dataset)
 *   APIFY_RUN_ID=ABC123XYZ node scripts/import-products-from-apify.mjs
 */

import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_RUN_ID = process.env.APIFY_RUN_ID || '';

// CLI arg can be a dataset ID, full API URL, or omitted (then read env var).
const ARG = process.argv[2] || '';
let APIFY_DATASET_ID = process.env.APIFY_DATASET_ID || '';
if (ARG) {
  // Extract dataset ID from a full URL like
  //   https://api.apify.com/v2/datasets/<id>/items?...
  const m = ARG.match(/\/datasets\/([^/?#]+)/i);
  APIFY_DATASET_ID = m ? m[1] : ARG;
}
const AMAZON_TAG = process.env.AMAZON_AFFILIATE_TAG || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;
const NO_PROMPT = process.env.NO_PROMPT === '1';
let TARGET_CATEGORY_SLUG = process.env.BLS_PRODUCT_CATEGORY || '';
let TARGET_CATEGORY_NAME_OVERRIDE = process.env.BLS_PRODUCT_CATEGORY_NAME || '';
let CREATE_CATEGORY = process.env.CREATE_CATEGORY === '1';

const UA = 'Mozilla/5.0 (compatible; bls-apify-importer/1.0)';

if (!STRAPI_TOKEN && !DRY_RUN) {
  console.error('ERROR: STRAPI_TOKEN env var required (or set DRY_RUN=1)');
  process.exit(1);
}

// --------------------------------------------------------------------------
// interactive prompts (skipped when NO_PROMPT=1 or stdin isn't a TTY)
// --------------------------------------------------------------------------
async function promptForMissing() {
  const havDataset = !!(APIFY_DATASET_ID || APIFY_RUN_ID);
  const havCategory = !!TARGET_CATEGORY_SLUG;
  if (havDataset && havCategory) return;
  if (NO_PROMPT || !input.isTTY) {
    if (!havDataset) {
      console.error(
        'ERROR: specify the source — pass dataset ID/URL as a CLI arg, set APIFY_DATASET_ID, or set APIFY_RUN_ID.\n' +
        '       (or run interactively without NO_PROMPT=1 in a TTY to be prompted)',
      );
      process.exit(1);
    }
    return;
  }

  const rl = createInterface({ input, output });
  try {
    if (!havDataset) {
      const ans = (await rl.question('\nApify dataset (ID or full API URL): ')).trim();
      if (!ans) {
        console.error('No dataset specified — aborting.');
        process.exit(1);
      }
      const m = ans.match(/\/datasets\/([^/?#]+)/i);
      APIFY_DATASET_ID = m ? m[1] : ans;
    }
    if (!havCategory) {
      const slug = (await rl.question('Target product category slug (blank = no category): ')).trim();
      if (slug) {
        TARGET_CATEGORY_SLUG = slug;
        // Check if this slug already exists; if not, prompt for name + auto-create.
        if (STRAPI_TOKEN) {
          const r = await strapi(
            `/api/bls-product-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`,
          );
          if (!(r.data && r.data[0])) {
            const defaultName = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
            const name = (await rl.question(
              `Category "${slug}" doesn't exist. Display name to create [${defaultName}]: `,
            )).trim();
            TARGET_CATEGORY_NAME_OVERRIDE = name || defaultName;
            CREATE_CATEGORY = true;
          }
        } else {
          // Without a token we can't pre-check — assume user wants auto-create
          CREATE_CATEGORY = true;
        }
      }
    }
  } finally {
    rl.close();
  }
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
const CURRENCY_MAP = {
  '$': 'USD',
  'US$': 'USD',
  '£': 'GBP',
  '€': 'EUR',
  'A$': 'AUD',
  'C$': 'CAD',
};

function normalizeCurrency(c) {
  if (!c) return 'USD';
  const trimmed = String(c).trim();
  if (CURRENCY_MAP[trimmed]) return CURRENCY_MAP[trimmed];
  // Already a 3-letter code? upper-case it
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  return trimmed.slice(0, 8);
}

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

function withAmazonTag(url, tag) {
  if (!tag || !url) return url;
  if (!/amazon\.[a-z.]+/i.test(url)) return url;
  if (/[?&]tag=/.test(url)) return url.replace(/([?&]tag=)[^&#]*/i, `$1${tag}`);
  return url + (url.includes('?') ? '&' : '?') + `tag=${tag}`;
}

// Detect "new" Apify Amazon Detail dataset (uses `title`, `attributes[]`,
// `highResolutionImages[]`) vs the older Best-Sellers format (uses `name`,
// `thumbnailUrl`, `categoryName`). Normalize both to a canonical shape so
// importItem can consume either.
function normalizeApifyItem(raw) {
  if (!raw) return null;
  const isNewFormat = raw.title && !raw.name;
  if (!isNewFormat) return raw; // legacy shape — pass through

  const attrs = raw.attributes || [];
  const findAttr = (...patterns) => {
    for (const a of attrs) {
      const k = (a?.key || '').toLowerCase();
      for (const p of patterns) {
        if (k.includes(p)) return a.value;
      }
    }
    return null;
  };

  // GTIN — only accept if it's 12-14 digits (rejects garbage like model
  // numbers or product-name fragments that occasionally land in this field).
  const rawGtin = findAttr('global trade');
  const gtin = rawGtin && /^\d{12,14}$/.test(String(rawGtin).trim())
    ? String(rawGtin).trim()
    : null;

  const mpn = findAttr('manufacturer part') || findAttr('model number') || findAttr('item model');

  // Breadcrumbs string → first / last segments as category hints.
  const crumbs = (raw.breadCrumbs || '').split(/\s*>\s*/).filter(Boolean);
  const subcategories = crumbs.slice(1).map((c) => ({ categoryName: c }));

  // Image preference: highResolutionImages > galleryThumbnails > thumbnailImage.
  const hi = Array.isArray(raw.highResolutionImages) && raw.highResolutionImages.length
    ? raw.highResolutionImages[0] : null;
  const thumbnailUrl = hi || raw.thumbnailImage || (raw.galleryThumbnails || [])[0] || null;

  return {
    name: raw.title,
    url: raw.url,
    asin: raw.asin || null,
    gtin,
    mpn: mpn ? String(mpn).slice(0, 80) : null,
    brand: raw.brand || null,
    description: raw.description || null,
    features: Array.isArray(raw.features) ? raw.features : [],
    breadCrumbs: raw.breadCrumbs || null,
    categoryName: crumbs[0] || null,
    subcategories,
    price: raw.price,
    listPrice: raw.listPrice,
    stars: raw.stars,
    reviewsCount: raw.reviewsCount,
    inStock: raw.inStock,
    thumbnailUrl,
    galleryUrls: (raw.highResolutionImages || raw.galleryThumbnails || []).slice(0, 8),
  };
}

function guessBrand(name) {
  if (!name) return null;
  // First "word" up to the first space, or first 2 words if very short.
  // Trim "by Brand" suffix, trim ALL CAPS only words.
  const tokens = name.trim().split(/\s+/);
  if (tokens.length === 0) return null;
  const first = tokens[0];
  // Heuristic: if first token is short and capitalized, use it; else first 2.
  if (first.length >= 3 && first.length <= 18) return first;
  return tokens.slice(0, 2).join(' ').slice(0, 30);
}

// --------------------------------------------------------------------------
// Apify
// --------------------------------------------------------------------------
// If APIFY_RUN_ID is set, resolve it to its default dataset ID.
async function resolveRunToDatasetId() {
  const url = new URL(`https://api.apify.com/v2/actor-runs/${APIFY_RUN_ID}`);
  if (APIFY_TOKEN) url.searchParams.set('token', APIFY_TOKEN);
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Apify run ${r.status} ${url.pathname}`);
  const body = await r.json();
  const dsId = body?.data?.defaultDatasetId;
  if (!dsId) throw new Error(`Apify run ${APIFY_RUN_ID} has no defaultDatasetId`);
  return dsId;
}

async function fetchApifyItems(datasetId) {
  const all = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const url = new URL(`https://api.apify.com/v2/datasets/${datasetId}/items`);
    url.searchParams.set('limit', String(PAGE));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('clean', '1');
    if (APIFY_TOKEN) url.searchParams.set('token', APIFY_TOKEN);
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Apify ${r.status} ${url.pathname}`);
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// --------------------------------------------------------------------------
// Strapi
// --------------------------------------------------------------------------
async function strapi(path, init = {}) {
  if (DRY_RUN && (init.method && init.method !== 'GET')) {
    console.log(`  [DRY RUN] ${init.method} ${path}`);
    return { data: { id: 0, documentId: 'dry' } };
  }
  const res = await fetch(`${STRAPI_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${STRAPI_TOKEN}`,
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Strapi ${res.status} ${init.method || 'GET'} ${path}\n${text}`);
  }
  return res.json();
}

const uploadCache = new Map(); // src URL → { id, url }

async function uploadImage(srcUrl, alt) {
  if (!srcUrl) return null;
  if (uploadCache.has(srcUrl)) return uploadCache.get(srcUrl);
  if (DRY_RUN) {
    const out = { id: 0, url: srcUrl };
    uploadCache.set(srcUrl, out);
    return out;
  }
  try {
    const r = await fetch(srcUrl, { headers: { 'User-Agent': UA, Referer: 'https://www.amazon.com/' } });
    if (!r.ok) throw new Error(`Image fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const filename = decodeURIComponent(srcUrl.split('/').pop().split('?')[0] || `img-${Date.now()}.jpg`);
    const form = new FormData();
    const blob = new Blob([buf], { type: r.headers.get('content-type') || 'image/jpeg' });
    form.append('files', blob, filename);
    if (alt) form.append('fileInfo', JSON.stringify({ alternativeText: alt }));
    const upRes = await fetch(`${STRAPI_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
      body: form,
    });
    if (!upRes.ok) throw new Error(`upload ${upRes.status}: ${await upRes.text().catch(() => '')}`);
    const arr = await upRes.json();
    const out = { id: arr[0].id, url: arr[0].url };
    uploadCache.set(srcUrl, out);
    return out;
  } catch (e) {
    console.warn(`  [warn] image upload failed for ${srcUrl.slice(0, 80)} — ${e.message}`);
    return null;
  }
}

async function findProductBySourceUrl(sourceUrl) {
  const r = await strapi(
    `/api/bls-products?filters[sourceUrl][$eq]=${encodeURIComponent(sourceUrl)}&pagination[pageSize]=1`,
  );
  return r.data?.[0] ?? null;
}

async function findOrCreateCategory(slug) {
  const r = await strapi(
    `/api/bls-product-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`,
  );
  if (r.data && r.data[0]) return r.data[0];

  if (!CREATE_CATEGORY) {
    throw new Error(
      `Target category "${slug}" not found. Either pre-create it in Strapi admin ` +
      `(BLS · Product Category → Create new), or re-run with CREATE_CATEGORY=1 to auto-create.`,
    );
  }

  // Auto-create
  const name = TARGET_CATEGORY_NAME_OVERRIDE
    || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  console.log(`  Auto-creating product category "${name}" (slug=${slug})...`);
  const created = await strapi('/api/bls-product-categories', {
    method: 'POST',
    body: JSON.stringify({ data: { name, slug } }),
  });
  return created.data;
}

// --------------------------------------------------------------------------
// import one item
// --------------------------------------------------------------------------
async function importItem(rawItem, targetCategoryId) {
  // Normalize to canonical shape (handles both old Best-Sellers and new
  // Detail-scraper datasets).
  const item = normalizeApifyItem(rawItem);
  const name = String(item?.name || '').trim();
  const url = item?.url || item?.productUrl || null;
  if (!name || !url) {
    return { skipped: true, reason: 'missing name or url' };
  }

  const asin = item.asin || null;
  const price = item.price?.value ?? item.price ?? null;
  const originalPrice = item.listPrice?.value;
  // amazon.com.au returns price.currency='$' which would mis-resolve to USD.
  // Use the URL host to override when the currency symbol is ambiguous.
  let currency = normalizeCurrency(item.price?.currency);
  const host = (() => { try { return new URL(item.url).host; } catch { return ''; } })();
  if (currency === 'USD' && host.endsWith('.com.au')) currency = 'AUD';
  else if (currency === 'USD' && host.endsWith('.co.uk')) currency = 'GBP';

  const stars = typeof item.stars === 'number' ? item.stars : null;
  // BLS schema is 0-10; Apify gives 0-5 → multiply by 2.
  const rating = stars !== null ? Math.min(10, Math.round(stars * 2 * 100) / 100) : undefined;
  const ratingCount = item.reviewsCount ?? undefined;

  // KeyFeatures: prefer the new dataset's `features` array (the "About this
  // item" bullets). Fall back to breadcrumb-style category trail.
  let keyFeatures;
  if (Array.isArray(item.features) && item.features.length) {
    keyFeatures = item.features.slice(0, 12).map((f) => String(f).slice(0, 300));
  } else {
    const crumbs = [];
    if (item.categoryName) crumbs.push(item.categoryName);
    for (const s of item.subcategories || []) if (s?.categoryName) crumbs.push(s.categoryName);
    keyFeatures = crumbs.length ? crumbs : undefined;
  }

  // Determine sourceMerchant variant from URL host (amazon.com.au → amazon-au)
  const sourceMerchant = host.endsWith('.com.au') ? 'amazon-au'
    : host.endsWith('.co.uk') ? 'amazon-uk'
    : 'amazon';

  // Image upload (primary; gallery upload is best-effort)
  const primaryImage = item.thumbnailUrl
    ? await uploadImage(item.thumbnailUrl, name)
    : null;

  const data = {
    name,
    slug: slugify(name),
    brand: item.brand || guessBrand(name) || undefined,
    asin: asin?.slice(0, 30),
    gtin: item.gtin || undefined,
    skuOrModel: item.mpn || undefined,
    sourceUrl: url,
    sourceMerchant,
    primaryAffiliateUrl: withAmazonTag(url, AMAZON_TAG),
    currentPrice: typeof price === 'number' ? price : undefined,
    originalPrice: typeof originalPrice === 'number' ? originalPrice : undefined,
    currency,
    rating,
    ratingCount,
    available: item.inStock !== false,
    lastPriceSyncAt: new Date().toISOString(),
    keyFeatures,
    ...(item.description ? { description: item.description.slice(0, 8000) } : {}),
    ...(primaryImage ? { primaryImage: primaryImage.id } : {}),
    ...(targetCategoryId ? { categories: [targetCategoryId] } : {}),
  };

  const existing = await findProductBySourceUrl(url);
  if (existing) {
    await strapi(`/api/bls-products/${existing.documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    });
    return { action: 'updated', name, asin };
  }
  const created = await strapi('/api/bls-products', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
  return { action: 'created', name, asin, id: created.data?.id };
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
async function main() {
  // Interactive prompt when needed (TTY only).
  await promptForMissing();

  // If APIFY_RUN_ID was given, resolve to its default dataset.
  let datasetId = APIFY_DATASET_ID;
  if (!datasetId && APIFY_RUN_ID) {
    console.log(`Resolving Apify run ${APIFY_RUN_ID} → default dataset...`);
    datasetId = await resolveRunToDatasetId();
    console.log(`  ✓ dataset = ${datasetId}\n`);
  }

  console.log(`Apify dataset:  ${datasetId}`);
  console.log(`Strapi:         ${STRAPI_URL}`);
  console.log(`Affiliate tag:  ${AMAZON_TAG || '(none — primaryAffiliateUrl = source URL as-is)'}`);
  console.log(`Target cat:     ${TARGET_CATEGORY_SLUG || '(none — products imported without a product category)'}`);
  if (DRY_RUN) console.log('*** DRY RUN — no Strapi writes ***');
  console.log('');

  // Resolve target category up front so we fail fast if it's missing.
  let targetCategoryId = null;
  if (TARGET_CATEGORY_SLUG) {
    const cat = await findOrCreateCategory(TARGET_CATEGORY_SLUG);
    targetCategoryId = cat?.id ?? null;
    console.log(`  ✓ category resolved: ${cat?.name ?? '(dry-run)'} (id=${targetCategoryId ?? 'dry'})\n`);
  }

  console.log('Fetching items from Apify…');
  let items = await fetchApifyItems(datasetId);
  console.log(`  ${items.length} items in dataset`);
  if (LIMIT > 0) {
    items = items.slice(0, LIMIT);
    console.log(`  LIMIT=${LIMIT} — processing first ${items.length}`);
  }
  console.log('');

  let ok = 0, updated = 0, skipped = 0, fail = 0;
  for (let i = 0; i < items.length; i++) {
    const tag = `[${i + 1}/${items.length}]`;
    try {
      const res = await importItem(items[i], targetCategoryId);
      if (res.skipped) {
        console.warn(`  ⊘ ${tag} ${(items[i].name || items[i].title || '?')?.slice(0, 60)} — ${res.reason}`);
        skipped++;
      } else if (res.action === 'created') {
        console.log(`  ✓ ${tag} ${res.name.slice(0, 70)}`);
        ok++;
      } else if (res.action === 'updated') {
        console.log(`  ↻ ${tag} ${res.name.slice(0, 70)} (updated)`);
        updated++;
      }
    } catch (e) {
      console.error(`  ✗ ${tag} ${(items[i].name || items[i].title || '?')?.slice(0, 60)} — ${e.message}`);
      fail++;
    }
  }

  console.log(
    `\n${ok} created, ${updated} updated, ${skipped} skipped, ${fail} failed.` +
    ` ${uploadCache.size} unique images uploaded.`,
  );
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
