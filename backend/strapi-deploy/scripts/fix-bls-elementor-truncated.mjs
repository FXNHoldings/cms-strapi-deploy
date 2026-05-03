#!/usr/bin/env node
/**
 * Re-import bestlooking.skin posts whose WP REST `content.rendered` was
 * truncated by a `<!--more-->` break. We scrape the front-end HTML, extract
 * the full Elementor body, run the Amazon-tag rewrite, and PUT the result
 * to Strapi (`bls-post`).
 *
 * Required env:
 *   STRAPI_URL              default: http://127.0.0.1:8888
 *   STRAPI_TOKEN            REQUIRED
 *
 * Optional env:
 *   AMAZON_AFFILIATE_TAG    Rewrites Amazon URLs in the scraped body
 *   FE_BASE                 default: https://www.bestlooking.skin
 *   ALL=1                   Process every Strapi post whose stored content
 *                           ends with a `class="more-link"` anchor
 *                           (heuristic for "this one is truncated").
 *   DRY_RUN=1               Print what would happen, no Strapi writes
 *
 * Usage:
 *   # one or more slugs
 *   STRAPI_TOKEN=... node scripts/fix-bls-elementor-truncated.mjs <slug1> <slug2> ...
 *
 *   # auto-detect every truncated post in Strapi and fix them all
 *   STRAPI_TOKEN=... ALL=1 node scripts/fix-bls-elementor-truncated.mjs
 */

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const AMAZON_TAG = process.env.AMAZON_AFFILIATE_TAG || '';
const FE_BASE = (process.env.FE_BASE || 'https://www.bestlooking.skin').replace(/\/$/, '');
const RUN_ALL = process.env.ALL === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

if (!STRAPI_TOKEN) { console.error('STRAPI_TOKEN required'); process.exit(1); }

const argSlugs = process.argv.slice(2);
if (argSlugs.length === 0 && !RUN_ALL) {
  console.error('Usage: node scripts/fix-bls-elementor-truncated.mjs <slug>...');
  console.error('   or: ALL=1 node scripts/fix-bls-elementor-truncated.mjs');
  process.exit(1);
}

// bestlooking.skin's WP categories — we try each prefix until we find the post
const CATEGORY_PREFIXES = [
  'skincare-how-to-guides',
  'skincare-reviews-path-to-glowing-skin',
  'top-rated-skincare-for-glowing-skin',
  'best-product-comparisons',
  'essential-guide-to-informative-articles',
  'reviews',
];

async function fetchFrontEndHtml(slug) {
  const errors = [];
  for (const cat of CATEGORY_PREFIXES) {
    const url = `${FE_BASE}/${cat}/${slug}/`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (r.ok) return await r.text();
      errors.push(`${cat}: HTTP ${r.status}`);
    } catch (e) {
      errors.push(`${cat}: ${e.message}`);
    }
  }
  // Fallback: try the root /<slug>/ in case category is different
  const root = `${FE_BASE}/${slug}/`;
  try {
    const r = await fetch(root, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (r.ok) return await r.text();
    errors.push(`root: HTTP ${r.status}`);
  } catch (e) { errors.push(`root: ${e.message}`); }
  throw new Error(`could not find ${slug} — tried: ${errors.join(', ')}`);
}

// Stack-based extraction of the inner HTML of the first
// <div data-elementor-type="wp-post" ...> in the page.
function extractElementorBody(html) {
  const open = html.match(/<div[^>]*data-elementor-type=["']wp-post["'][^>]*>/);
  if (!open) throw new Error('no <div data-elementor-type="wp-post"> found');
  const startInner = open.index + open[0].length;

  let depth = 1;
  let i = startInner;
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = startInner;
  let m;
  while ((m = tagRe.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      i = m.index;
      break;
    }
  }
  return html.slice(startInner, i).trim();
}

function cleanBody(html) {
  // Strip the "(more...)" anchor that lands at the end of truncated copies
  html = html.replace(/<a\b[^>]*class="[^"]*\bmore-link\b[^"]*"[^>]*>.*?<\/a>/gis, '');
  return html.trim();
}

function rewriteAmazonTag(html, tag) {
  if (!tag) return html;
  // Replace existing tag= values with the configured tag
  html = html.replace(
    /(https?:\/\/[^"'\s>]*amazon\.[a-z.]+[^"'\s>]*[?&]tag=)[^&"'\s>]+/gi,
    `$1${tag}`,
  );
  // Append tag= when an Amazon URL has no tag
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

async function strapi(path, init = {}) {
  const r = await fetch(`${STRAPI_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${STRAPI_TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!r.ok) {
    throw new Error(`Strapi ${r.status} ${init.method || 'GET'} ${path}: ${(await r.text().catch(() => '')).slice(0, 240)}`);
  }
  return r.json();
}

async function findStrapiPost(slug) {
  const r = await strapi(
    `/api/bls-posts?filters%5Bslug%5D%5B%24eq%5D=${encodeURIComponent(slug)}&pagination%5BpageSize%5D=1`,
  );
  return r.data?.[0] ?? null;
}

// Heuristic for "truncated": stored content has a `class="...more-link..."`
// anchor near the end (the WP REST API's signature when there's a
// <!--more--> tag). We just check the last 800 chars for the marker —
// simpler and more robust than trying to anchor a regex to end-of-string
// since the anchor often wraps a <span>.
function isTruncated(content) {
  if (!content) return false;
  const tail = content.slice(-800);
  return /class="[^"]*\bmore-link\b/i.test(tail);
}

async function listTruncatedSlugs() {
  const out = [];
  let page = 1;
  for (;;) {
    const r = await strapi(
      `/api/bls-posts?fields%5B0%5D=slug&fields%5B1%5D=content&pagination%5Bpage%5D=${page}&pagination%5BpageSize%5D=100`,
    );
    const data = r.data || [];
    for (const p of data) {
      if (isTruncated(p.content)) out.push(p.slug);
    }
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page += 1;
  }
  return out;
}

async function fixOne(slug) {
  const post = await findStrapiPost(slug);
  if (!post) { console.error(`  ! no Strapi post with slug=${slug}`); return { ok: false, slug }; }

  const fe = await fetchFrontEndHtml(slug);
  const raw = extractElementorBody(fe);
  let content = cleanBody(raw);
  content = rewriteAmazonTag(content, AMAZON_TAG);

  const beforeLen = (post.content || '').length;
  console.log(`  ${slug}: ${beforeLen} → ${content.length} chars` + (DRY_RUN ? ' (DRY RUN)' : ''));

  if (DRY_RUN) return { ok: true, slug, before: beforeLen, after: content.length };

  // Update both draft and published copies (Strapi v5 draftAndPublish writes one row each)
  await strapi(`/api/bls-posts/${post.documentId}?status=draft`, {
    method: 'PUT',
    body: JSON.stringify({ data: { content } }),
  });
  await strapi(`/api/bls-posts/${post.documentId}?status=published`, {
    method: 'PUT',
    body: JSON.stringify({ data: { content } }),
  });
  return { ok: true, slug, before: beforeLen, after: content.length };
}

async function main() {
  let slugs = argSlugs;
  if (RUN_ALL) {
    console.log('Scanning Strapi for truncated posts...');
    slugs = await listTruncatedSlugs();
    console.log(`Found ${slugs.length} truncated posts.`);
  }
  let ok = 0, fail = 0;
  for (const s of slugs) {
    try {
      await fixOne(s);
      ok += 1;
    } catch (e) {
      console.error(`  ✗ ${s}: ${e.message}`);
      fail += 1;
    }
  }
  console.log(`\nDone. fixed=${ok} failed=${fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
