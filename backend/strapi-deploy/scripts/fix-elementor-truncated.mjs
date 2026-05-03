#!/usr/bin/env node
/**
 * One-off: re-import posts whose WP REST `content.rendered` was truncated
 * by a `<!--more-->` break. We scrape the front-end HTML, extract the full
 * elementor-rendered body, run the same Amazon-tag rewrite as the main
 * importer, and PUT the result to Strapi.
 *
 * Usage:
 *   STRAPI_TOKEN=... AMAZON_AFFILIATE_TAG=unitradeco-20 \
 *     node scripts/fix-elementor-truncated.mjs <slug1> <slug2> ...
 *
 *   (Slugs are the URL slugs from nxt.bargains, e.g. voice-control-smart-outlets)
 */

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const AMAZON_TAG = process.env.AMAZON_AFFILIATE_TAG || '';
const UA = 'Mozilla/5.0 (compatible; nxt-bargains-importer/1.0)';

if (!STRAPI_TOKEN) { console.error('STRAPI_TOKEN required'); process.exit(1); }

const slugs = process.argv.slice(2);
if (slugs.length === 0) { console.error('Usage: node scripts/fix-elementor-truncated.mjs <slug>...'); process.exit(1); }

// nxt.bargains uses one URL per category; try each known category prefix.
const CATEGORY_PREFIXES = [
  'nxt-bargains-informative-articles',
  'product-comparisons',
  'product-reviews',
  'product-roundups',
  'how-to-guides',
  'top-rated-smart-electronics-devices',
];

async function fetchFrontEndHtml(slug) {
  for (const cat of CATEGORY_PREFIXES) {
    const url = `https://nxt.bargains/${cat}/${slug}/`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return await r.text();
  }
  throw new Error(`could not find ${slug} under any known category prefix`);
}

// Stack-based extraction of the inner HTML of the first
// <div data-elementor-type="wp-post" ...> in the page.
function extractElementorBody(html) {
  const open = html.match(/<div[^>]*data-elementor-type=["']wp-post["'][^>]*>/);
  if (!open) throw new Error('no <div data-elementor-type="wp-post"> found');
  const startInner = open.index + open[0].length;

  // Walk forward, tracking <div> open/close depth (start at 1 for the opener).
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

// Remove obvious chrome that escapes from the elementor body: read-more links,
// continue-reading anchors, related-posts widgets we don't want.
function cleanBody(html) {
  // Strip "(more...)" continue-reading anchor injected by WP excerpt
  html = html.replace(/<a\b[^>]*class="[^"]*\bmore-link\b[^"]*"[^>]*>.*?<\/a>/gis, '');
  // Strip Elementor's "skip to content" or screen-reader chrome if present
  html = html.replace(/<div[^>]*class="[^"]*elementor-element-populated[^"]*"[^>]*>([^<])/gi, '<div>$1');
  return html.trim();
}

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

async function strapi(path, init = {}) {
  const r = await fetch(`${STRAPI_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${STRAPI_TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!r.ok) throw new Error(`Strapi ${r.status} ${init.method || 'GET'} ${path}: ${await r.text().catch(() => '')}`);
  return r.json();
}

async function findStrapiPost(slug) {
  const r = await strapi(`/api/nxt-posts?filters%5Bslug%5D%5B%24eq%5D=${encodeURIComponent(slug)}&pagination%5BpageSize%5D=1`);
  return r.data?.[0] ?? null;
}

async function fixOne(slug) {
  console.log(`\n== ${slug} ==`);
  const fe = await fetchFrontEndHtml(slug);
  const raw = extractElementorBody(fe);
  let content = cleanBody(raw);
  content = rewriteAmazonTag(content, AMAZON_TAG);

  const post = await findStrapiPost(slug);
  if (!post) { console.error(`  ! no Strapi post with slug=${slug}`); return; }
  console.log(`  scraped body: ${content.length} chars  (was: ${(post.content || '').length})`);

  await strapi(`/api/nxt-posts/${post.documentId}?status=draft`, {
    method: 'PUT',
    body: JSON.stringify({ data: { content } }),
  });
  await strapi(`/api/nxt-posts/${post.documentId}?status=published`, {
    method: 'PUT',
    body: JSON.stringify({ data: { content } }),
  });
  console.log(`  ✓ updated draft + published copies`);
}

for (const s of slugs) {
  try { await fixOne(s); } catch (e) { console.error(`  ✗ ${s}: ${e.message}`); }
}
