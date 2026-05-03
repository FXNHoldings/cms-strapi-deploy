#!/usr/bin/env node
/**
 * Import bestlooking.skin WordPress content into Strapi (`bls-category`, `bls-post`).
 *
 * Idempotent: every entry stores `legacyWpId`, so re-running updates rather
 * than duplicating. Safe to run repeatedly while iterating.
 *
 * Required env:
 *   STRAPI_URL                 default: http://127.0.0.1:8888
 *   STRAPI_TOKEN               REQUIRED  Strapi → Settings → API Tokens (full access)
 *
 * Optional env:
 *   AMAZON_AFFILIATE_TAG       Rewrites/adds `tag=...` on amazon.* URLs in post HTML.
 *                              Leave empty to preserve the source links untouched.
 *   WP_BASE                    default: https://bestlooking.skin/wp-json/wp/v2
 *   ONLY_SLUG                  Import only one post (by slug). Useful for testing.
 *   DRY_RUN=1                  Don't write to Strapi — log what would happen.
 *   SKIP_INLINE_IMAGES=1       Don't download <img> tags inside post content.
 *
 * Run:
 *   STRAPI_TOKEN=... AMAZON_AFFILIATE_TAG=unitradeco-20 \
 *     node scripts/import-bestlooking-skin.mjs
 */

import { Buffer } from 'node:buffer';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ---------- config ----------
const WP_BASE = (process.env.WP_BASE || 'https://bestlooking.skin/wp-json/wp/v2').replace(/\/$/, '');
const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const AMAZON_TAG = process.env.AMAZON_AFFILIATE_TAG || '';
const ONLY_SLUG = process.env.ONLY_SLUG || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const SKIP_INLINE_IMAGES = process.env.SKIP_INLINE_IMAGES === '1';
// SKIP_IF_HAS_COVER=1 — re-run only the posts that DON'T have a cover image
// yet. Useful when the first import partially succeeded and you only want to
// retry the broken ones without overwriting the working ones.
const SKIP_IF_HAS_COVER = process.env.SKIP_IF_HAS_COVER === '1';

const UA = 'Mozilla/5.0 (compatible; bestlooking-skin-importer/1.0)';

if (!STRAPI_TOKEN && !DRY_RUN) {
  console.error('ERROR: STRAPI_TOKEN env var required. Generate one in Strapi → Settings → API Tokens (Full access).');
  process.exit(1);
}

// Categories to seed (mirrors source bestlooking.skin /wp-json category list,
// excluding empty brand taxonomies). Order is the display order.
const CATEGORIES = [
  { name: 'Product Comparisons',  slug: 'best-product-comparisons',                 order: 1, legacyWpId: 186 },
  { name: 'Product Reviews',      slug: 'skincare-reviews-path-to-glowing-skin',    order: 2, legacyWpId:  41 },
  { name: 'Top-Rated Skincare',   slug: 'top-rated-skincare-for-glowing-skin',      order: 3, legacyWpId:  45 },
  { name: 'How-to Guides',        slug: 'skincare-how-to-guides',                   order: 4, legacyWpId:  42 },
  { name: 'Informative Articles', slug: 'essential-guide-to-informative-articles',  order: 5, legacyWpId:  43 },
  { name: 'Brand Reviews',        slug: 'reviews',                                  order: 6, legacyWpId: 511 },
];

// WP category slug → bls-post `postType` enum value
const POSTTYPE_MAP = {
  'best-product-comparisons':                 'product-comparison',
  'skincare-reviews-path-to-glowing-skin':    'product-review',
  'top-rated-skincare-for-glowing-skin':      'top-rated',
  'skincare-how-to-guides':                   'how-to-guide',
  'essential-guide-to-informative-articles':  'informative',
  'reviews':                                  'product-review',
};

// ---------- HTTP helpers ----------
async function strapi(path, init = {}) {
  if (DRY_RUN && (init.method && init.method !== 'GET')) {
    console.log(`  [DRY RUN] ${init.method} ${path}`);
    return { data: { id: 0, documentId: 'dry', attributes: {} } };
  }
  const url = `${STRAPI_URL}${path}`;
  const res = await fetch(url, {
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

async function fetchJsonWithRetry(url, label = url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text) throw new Error('empty body');
      return JSON.parse(text);
    } catch (e) {
      if (attempt === 4) throw new Error(`${label} failed after 4 attempts: ${e.message}`);
      const wait = 2000 * attempt;
      console.warn(`    [retry ${attempt}] ${label} — ${e.message}, sleeping ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function wpFetch(path) {
  const url = path.startsWith('http') ? path : `${WP_BASE}${path}`;
  const data = await fetchJsonWithRetry(url, `WP ${path}`);
  if (data === null) throw new Error(`WP ${url} → 404/400`);
  return data;
}

// ---------- categories ----------
async function findCategoryBySlug(slug) {
  const r = await strapi(`/api/bls-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`);
  return r.data?.[0] ?? null;
}

async function upsertCategory(cat) {
  const existing = await findCategoryBySlug(cat.slug);
  const data = { name: cat.name, slug: cat.slug, order: cat.order, legacyWpId: cat.legacyWpId };
  if (existing) {
    await strapi(`/api/bls-categories/${existing.documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    });
    return existing;
  }
  const created = await strapi('/api/bls-categories', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
  return created.data;
}

// ---------- media ----------
const uploadCache = new Map(); // src URL → { id, url }

async function uploadFromUrl(srcUrl, alt = '') {
  if (uploadCache.has(srcUrl)) return uploadCache.get(srcUrl);

  const filename = decodeURIComponent(srcUrl.split('/').pop().split('?')[0] || `img-${Date.now()}`);
  const existing = await strapi(`/api/upload/files?filters[name][$eq]=${encodeURIComponent(filename)}&pagination[pageSize]=1`)
    .catch(() => null);
  if (existing && Array.isArray(existing) && existing.length > 0) {
    const out = { id: existing[0].id, url: existing[0].url };
    uploadCache.set(srcUrl, out);
    return out;
  }

  if (DRY_RUN) {
    const out = { id: 0, url: srcUrl };
    uploadCache.set(srcUrl, out);
    return out;
  }

  const r = await fetch(srcUrl, { headers: { 'User-Agent': UA, Referer: 'https://bestlooking.skin/' } });
  if (!r.ok) throw new Error(`Image fetch ${r.status}: ${srcUrl}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const form = new FormData();
  const blob = new Blob([buf], { type: r.headers.get('content-type') || 'application/octet-stream' });
  form.append('files', blob, filename);
  if (alt) form.append('fileInfo', JSON.stringify({ alternativeText: alt }));

  const upRes = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
    body: form,
  });
  if (!upRes.ok) {
    const text = await upRes.text().catch(() => '');
    throw new Error(`Strapi upload ${upRes.status}: ${text}`);
  }
  const arr = await upRes.json();
  const out = { id: arr[0].id, url: arr[0].url };
  uploadCache.set(srcUrl, out);
  return out;
}

async function fetchFeaturedMediaUrl(mediaId) {
  if (!mediaId) return null;
  const url = `${WP_BASE}/media/${mediaId}`;
  try {
    const m = await fetchJsonWithRetry(url, `WP media ${mediaId}`);
    return m?.source_url || null;
  } catch (e) {
    console.warn(`    [warn] media ${mediaId} fetch failed: ${e.message}`);
    return null;
  }
}

// ---------- content rewriting ----------

function rewriteAmazonTag(html, tag) {
  if (!tag) return html;
  html = html.replace(
    /(https?:\/\/[^"'\s>]*amazon\.[a-z.]+[^"'\s>]*[?&]tag=)[^&"'\s>]+/gi,
    `$1${tag}`,
  );
  html = html.replace(
    /(https?:\/\/[^"'\s>]*amazon\.[a-z.]+[^"'\s>]*?)(["'\s>])/gi,
    (full, urlPart, end) => {
      if (/[?&]tag=/.test(urlPart)) return full;
      const sep = urlPart.includes('?') ? '&' : '?';
      return `${urlPart}${sep}tag=${tag}${end}`;
    },
  );
  return html;
}

function extractFirstImageUrl(html) {
  const m = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(String(html || ''));
  return m ? m[1] : null;
}

async function rewriteInlineImages(html) {
  if (SKIP_INLINE_IMAGES) return html;
  const imgRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const found = new Set();
  let m;
  while ((m = imgRegex.exec(html))) {
    const src = m[1];
    if (/(^|\.)bestlooking\.skin/.test(src) || src.startsWith('https://bestlooking.skin/')) {
      found.add(src);
    }
  }
  for (const src of found) {
    try {
      const up = await uploadFromUrl(src);
      const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const newUrl = up.url.startsWith('http') ? up.url : `${STRAPI_URL}${up.url}`;
      html = html.replace(new RegExp(escaped, 'g'), newUrl);
    } catch (e) {
      console.warn(`    [warn] inline image failed: ${src} — ${e.message}`);
    }
  }
  return html;
}

function decodeHtmlEntities(s = '') {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
    .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ');
}

function readingTime(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(words / 200));
}

// ---------- posts ----------
async function findPostByLegacyId(legacyWpId) {
  const r = await strapi(
    `/api/bls-posts?filters[legacyWpId][$eq]=${legacyWpId}&pagination[pageSize]=1&populate[coverImage][fields][0]=url`,
  );
  return r.data?.[0] ?? null;
}

async function fetchAllWpPosts() {
  // Skip _embed (the source server can flake under load), pull featured media on demand.
  const PER_PAGE = 20;
  const out = [];
  let page = 1;
  while (true) {
    const url = ONLY_SLUG
      ? `${WP_BASE}/posts?slug=${encodeURIComponent(ONLY_SLUG)}`
      : `${WP_BASE}/posts?per_page=${PER_PAGE}&page=${page}`;
    const batch = await fetchJsonWithRetry(url, `WP posts page ${page}`);
    if (!batch) break;
    out.push(...batch);
    if (ONLY_SLUG || batch.length < PER_PAGE) break;
    page++;
  }
  return out;
}

function pickPostType(wpCatSlugs) {
  for (const slug of wpCatSlugs) {
    if (POSTTYPE_MAP[slug]) return POSTTYPE_MAP[slug];
  }
  return 'other';
}

// Strapi v5 + draftAndPublish auto-stamps publishedAt on create and ignores
// values we send. We collect (legacyWpId → date_gmt) here and backfill via
// direct SQL once all rows exist.
const publishedAtBackfill = new Map();

async function importPost(wpPost, slugByCatId) {
  // Fast-path: if SKIP_IF_HAS_COVER=1 and an existing Strapi post already has
  // a coverImage, skip without re-fetching media or re-uploading anything.
  if (SKIP_IF_HAS_COVER) {
    const existing = await findPostByLegacyId(wpPost.id);
    if (existing && existing.coverImage) {
      return { action: 'skipped', reason: 'has-cover', id: existing.id };
    }
  }

  const wpCatIds = wpPost.categories || [];
  const wpCatSlugs = wpCatIds.map((id) => slugByCatId.get(id)).filter(Boolean);

  // Map to Strapi bls-category IDs
  const strapiCatIds = [];
  for (const slug of wpCatSlugs) {
    const c = await findCategoryBySlug(slug);
    if (c) strapiCatIds.push(c.id);
  }

  // Featured image (fetched separately since we skip _embed for reliability)
  let coverImageId = null;
  const featuredMediaId = wpPost.featured_media;
  if (featuredMediaId && featuredMediaId > 0 && featuredMediaId < 1e10) {
    const src = await fetchFeaturedMediaUrl(featuredMediaId);
    if (src) {
      try {
        const up = await uploadFromUrl(src);
        coverImageId = up.id;
      } catch (e) {
        console.warn(`  [warn] featured image failed for "${wpPost.slug}": ${e.message}`);
      }
    }
  }

  let content = wpPost.content?.rendered || '';

  // Fallback: if no usable featured_media, use first <img src> in content as cover.
  if (!coverImageId) {
    const firstImg = extractFirstImageUrl(content);
    if (firstImg) {
      try {
        const up = await uploadFromUrl(firstImg);
        coverImageId = up.id;
      } catch (e) {
        console.warn(`  [warn] first-image fallback failed for "${wpPost.slug}": ${e.message}`);
      }
    }
  }
  content = rewriteAmazonTag(content, AMAZON_TAG);
  content = await rewriteInlineImages(content);

  const title = decodeHtmlEntities(wpPost.title?.rendered || '').trim();
  const excerptHtml = wpPost.excerpt?.rendered || '';
  const excerpt = decodeHtmlEntities(excerptHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 480);

  const data = {
    title,
    slug: wpPost.slug,
    excerpt,
    content,
    postType: pickPostType(wpCatSlugs),
    sourceUrl: wpPost.link,
    legacyWpId: wpPost.id,
    readingTimeMinutes: readingTime(content),
    source: 'wp-import',
    publishedAt: wpPost.date_gmt ? `${wpPost.date_gmt}.000Z` : new Date().toISOString(),
    categories: strapiCatIds,
    ...(coverImageId ? { coverImage: coverImageId, ogImage: coverImageId } : {}),
    ...(AMAZON_TAG ? { amazonAffiliateTag: AMAZON_TAG } : {}),
  };

  if (wpPost.date_gmt) {
    publishedAtBackfill.set(wpPost.id, `${wpPost.date_gmt}+00`);
  }

  const existing = await findPostByLegacyId(wpPost.id);
  if (existing) {
    await strapi(`/api/bls-posts/${existing.documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    });
    return { action: 'updated', id: existing.id };
  }
  const created = await strapi('/api/bls-posts', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
  return { action: 'created', id: created.data?.id };
}

function backfillPublishedAt() {
  if (publishedAtBackfill.size === 0 || DRY_RUN) return;
  const cases = [];
  const ids = [];
  for (const [legacyId, ts] of publishedAtBackfill) {
    cases.push(`WHEN legacy_wp_id = ${Number(legacyId)} THEN '${ts}'::timestamp`);
    ids.push(Number(legacyId));
  }
  // Only stamp the published rows (Strapi v5 has draft+published rows per
  // document; touching the draft hides it from the Content Manager UI).
  const sql = `UPDATE bls_posts SET published_at = CASE ${cases.join(' ')} END WHERE published_at IS NOT NULL AND legacy_wp_id IN (${ids.join(',')});`;

  const env = require_env_kv('/opt/fxn-cms-git/backend/strapi-deploy/.env');
  const dbName = env.DATABASE_NAME;
  const dbUser = env.DATABASE_USERNAME;
  if (!dbName || !dbUser) {
    console.warn('  [warn] Could not read DB creds from strapi-deploy/.env — skipping publishedAt backfill.');
    return;
  }
  const out = execSync(
    `docker exec -i fxn-postgres psql -U ${dbUser} -d ${dbName} -c ${JSON.stringify(sql)}`,
    { encoding: 'utf8' },
  );
  console.log(`  ✓ publishedAt backfill: ${out.trim()}`);
}

function require_env_kv(path) {
  const out = {};
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return out;
}

// ---------- main ----------
async function main() {
  console.log(`Strapi: ${STRAPI_URL}   WP: ${WP_BASE}`);
  console.log(`Affiliate tag: ${AMAZON_TAG ? AMAZON_TAG : '(none — leaving links untouched)'}`);
  if (DRY_RUN) console.log('*** DRY RUN — no Strapi writes ***');
  console.log('');

  // 1. Categories
  console.log('Categories:');
  for (const cat of CATEGORIES) {
    const r = await upsertCategory(cat);
    console.log(`  ✓ ${cat.name}  (slug=${cat.slug}, id=${r.id ?? 'dry'})`);
  }
  console.log('');

  // 2. Build WP-cat-id → slug map
  console.log('Fetching WP category map...');
  const wpCats = await wpFetch('/categories?per_page=100');
  const slugByCatId = new Map(wpCats.map((c) => [c.id, c.slug]));
  console.log(`  ${wpCats.length} categories on source\n`);

  // 3. Posts
  console.log('Posts:');
  const wpPosts = await fetchAllWpPosts();
  console.log(`  ${wpPosts.length} posts on source\n`);
  let ok = 0, fail = 0;
  for (let i = 0; i < wpPosts.length; i++) {
    const p = wpPosts[i];
    const tag = `[${i + 1}/${wpPosts.length}] ${p.slug}`;
    try {
      const res = await importPost(p, slugByCatId);
      console.log(`  ✓ ${tag} — ${res.action}`);
      ok++;
    } catch (e) {
      console.error(`  ✗ ${tag} — ${e.message}`);
      fail++;
    }
  }
  console.log(`\n${ok} ok, ${fail} failed, ${uploadCache.size} unique images uploaded.`);

  // 4. Backfill publishedAt
  console.log('\nBackfilling publishedAt from WP dates...');
  backfillPublishedAt();
  console.log('Done.');

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
