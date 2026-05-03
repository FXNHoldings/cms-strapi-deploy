#!/usr/bin/env node
/**
 * Import a single product into Strapi (`bls-product`) by URL.
 *
 * Extraction strategy, in order of preference:
 *   1. JSON-LD `@type: Product` blocks (most reliable, used by Amazon, eBay,
 *      Walmart, Sephora, Ulta, Target, most major retailers).
 *   2. OpenGraph product meta tags (og:title, og:image, product:price:*).
 *   3. Site-specific HTML selectors for known marketplaces (Amazon, eBay,
 *      Walmart) — last resort, fragile.
 *
 * Limits — worth knowing:
 *   - Amazon often blocks scraping with 503/CAPTCHA. When that happens this
 *     script falls back to whatever <meta> tags it can find.
 *   - For reliable Amazon at scale you need PAAPI 5 (Associates API
 *     credentials). Out of scope here.
 *   - If a site renders content via client-side JS only, extraction returns
 *     thin results (we don't run a headless browser).
 *
 * Required env:
 *   STRAPI_URL         default: http://127.0.0.1:8888
 *   STRAPI_TOKEN       REQUIRED  Strapi → Settings → API Tokens (full access)
 *
 * Optional env:
 *   AMAZON_AFFILIATE_TAG   Adds/replaces `tag=...` on Amazon URLs going into
 *                          primaryAffiliateUrl.
 *   DRY_RUN=1              Print extracted data, don't write to Strapi.
 *
 * Usage:
 *   STRAPI_TOKEN=... node scripts/import-product-from-url.mjs <product-url>
 */

import { Buffer } from 'node:buffer';

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const AMAZON_TAG = process.env.AMAZON_AFFILIATE_TAG || '';
const DRY_RUN = process.env.DRY_RUN === '1';

const URL_ARG = process.argv[2];
if (!URL_ARG) {
  console.error('Usage: node scripts/import-product-from-url.mjs <product-url>');
  process.exit(1);
}
if (!STRAPI_TOKEN && !DRY_RUN) {
  console.error('ERROR: STRAPI_TOKEN env var required (or set DRY_RUN=1).');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --------------------------------------------------------------------------
// merchant detection
// --------------------------------------------------------------------------
function detectMerchant(url) {
  const h = new URL(url).hostname.toLowerCase();
  if (h.includes('amazon.co.uk')) return 'amazon-uk';
  if (h.includes('amazon.com.au')) return 'amazon-au';
  if (h.includes('amazon.')) return 'amazon';
  if (h.includes('ebay.')) return 'ebay';
  if (h.includes('walmart.')) return 'walmart';
  if (h.includes('target.com')) return 'target';
  if (h.includes('sephora.')) return 'sephora';
  if (h.includes('ulta.')) return 'ulta';
  return 'other';
}

function extractAsin(url) {
  const m = url.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i);
  return m ? m[1] : null;
}

function withAmazonTag(url, tag) {
  if (!tag) return url;
  if (!/amazon\.[a-z.]+/i.test(url)) return url;
  if (/[?&]tag=/.test(url)) {
    return url.replace(/([?&]tag=)[^&#]*/i, `$1${tag}`);
  }
  return url + (url.includes('?') ? '&' : '?') + `tag=${tag}`;
}

// --------------------------------------------------------------------------
// HTML helpers
// --------------------------------------------------------------------------
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Fetch ${res.status} on ${url}`);
  return res.text();
}

function decodeHtmlEntities(s = '') {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
    .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function metaContent(html, name) {
  // matches both name=... and property=... in any order
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']+)["']`,
    'i',
  );
  const m = html.match(re);
  if (m) return decodeHtmlEntities(m[1]);
  // also try content first then name (some sites swap order)
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i',
  );
  const m2 = html.match(re2);
  return m2 ? decodeHtmlEntities(m2[1]) : null;
}

// --------------------------------------------------------------------------
// extractors
// --------------------------------------------------------------------------

// 1. JSON-LD — pull every <script type="application/ld+json"> and look for
//    Product entries (some pages ship multiple, including @graph arrays).
function extractFromJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim();
    // some pages cdata-wrap or have stray HTML comments
    raw = raw.replace(/^<!--/, '').replace(/-->$/, '').trim();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const candidates = item['@graph'] ? item['@graph'] : [item];
        for (const c of candidates) {
          const t = Array.isArray(c['@type']) ? c['@type'] : [c['@type']];
          if (t.some((x) => String(x || '').toLowerCase().includes('product'))) {
            out.push(c);
          }
        }
      }
    } catch { /* skip malformed JSON-LD blocks */ }
  }
  return out;
}

function pickPrimaryProduct(jsonLdProducts) {
  // Prefer the entry with most price/image data
  let best = null;
  let bestScore = -1;
  for (const p of jsonLdProducts) {
    let score = 0;
    if (p.name) score += 2;
    if (p.image) score += 2;
    if (p.offers) score += 3;
    if (p.brand) score += 1;
    if (p.description) score += 1;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

function extractOfferPrice(offers) {
  if (!offers) return { price: null, currency: null, available: null };
  const list = Array.isArray(offers) ? offers : [offers];
  // Use first concrete Offer (some sites use AggregateOffer with .lowPrice)
  for (const o of list) {
    if (typeof o.price === 'string' || typeof o.price === 'number') {
      return {
        price: Number(o.price) || null,
        currency: o.priceCurrency || o.currency || null,
        available: typeof o.availability === 'string'
          ? /InStock/i.test(o.availability)
          : null,
      };
    }
    if (o.lowPrice) {
      return {
        price: Number(o.lowPrice) || null,
        currency: o.priceCurrency || null,
        available: null,
      };
    }
  }
  return { price: null, currency: null, available: null };
}

function asImageArray(image) {
  if (!image) return [];
  if (typeof image === 'string') return [image];
  if (Array.isArray(image)) return image.flatMap(asImageArray);
  if (typeof image === 'object' && image.url) return [image.url];
  return [];
}

// 2. OpenGraph fallback — used when JSON-LD is absent / thin.
function extractFromOpenGraph(html) {
  return {
    name:        metaContent(html, 'og:title') || metaContent(html, 'twitter:title'),
    description: metaContent(html, 'og:description') || metaContent(html, 'twitter:description') || metaContent(html, 'description'),
    images:      [metaContent(html, 'og:image') || metaContent(html, 'twitter:image')].filter(Boolean),
    price:       Number(metaContent(html, 'product:price:amount') || metaContent(html, 'og:price:amount')) || null,
    currency:    metaContent(html, 'product:price:currency') || metaContent(html, 'og:price:currency'),
    brand:       metaContent(html, 'product:brand') || metaContent(html, 'og:brand') || metaContent(html, 'brand'),
  };
}

// 3. Site-specific helpers (very limited; JSON-LD usually wins).
function extractAmazonFallback(html) {
  // Title
  const t = html.match(/<span[^>]+id=["']productTitle["'][^>]*>([^<]+)</i);
  // Price
  const p = html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>\$?([\d.,]+)</i);
  return {
    name:  t ? decodeHtmlEntities(t[1].trim()) : null,
    price: p ? Number(p[1].replace(/,/g, '')) : null,
    currency: 'USD',
  };
}

// --------------------------------------------------------------------------
// Strapi calls
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

async function uploadImage(srcUrl, altText) {
  if (DRY_RUN) return { id: 0, url: srcUrl };
  const r = await fetch(srcUrl, { headers: { 'User-Agent': UA, Referer: URL_ARG } });
  if (!r.ok) throw new Error(`Image fetch ${r.status}: ${srcUrl}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const filename = decodeURIComponent(srcUrl.split('/').pop().split('?')[0] || `img-${Date.now()}.jpg`);
  const form = new FormData();
  const blob = new Blob([buf], { type: r.headers.get('content-type') || 'image/jpeg' });
  form.append('files', blob, filename);
  if (altText) form.append('fileInfo', JSON.stringify({ alternativeText: altText }));
  const upRes = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
    body: form,
  });
  if (!upRes.ok) throw new Error(`Upload ${upRes.status}: ${await upRes.text().catch(() => '')}`);
  const arr = await upRes.json();
  return { id: arr[0].id, url: arr[0].url };
}

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
async function main() {
  console.log(`Source URL: ${URL_ARG}`);
  const merchant = detectMerchant(URL_ARG);
  console.log(`Detected merchant: ${merchant}`);
  if (DRY_RUN) console.log('*** DRY RUN — no Strapi writes ***\n');

  console.log('Fetching page...');
  let html;
  try {
    html = await fetchHtml(URL_ARG);
  } catch (e) {
    console.error(`Failed to fetch: ${e.message}`);
    process.exit(1);
  }
  console.log(`  ${html.length} bytes\n`);

  // 1. JSON-LD
  const jsonLd = extractFromJsonLd(html);
  console.log(`JSON-LD Product entries: ${jsonLd.length}`);
  const primary = pickPrimaryProduct(jsonLd);

  // 2. OpenGraph fallback
  const og = extractFromOpenGraph(html);

  // 3. Site-specific
  const amzFallback = (merchant === 'amazon' || merchant.startsWith('amazon-')) ? extractAmazonFallback(html) : null;

  // Combine — prefer JSON-LD, then OG, then site-specific
  const name        = primary?.name || og.name || amzFallback?.name || null;
  const description = primary?.description || og.description || null;
  const brand       = (primary?.brand?.name) || (typeof primary?.brand === 'string' ? primary.brand : null) || og.brand || null;
  const sku         = primary?.sku || primary?.mpn || null;
  const asin        = extractAsin(URL_ARG);

  const offerPrice  = extractOfferPrice(primary?.offers);
  const currentPrice = offerPrice.price ?? og.price ?? amzFallback?.price ?? null;
  const currency     = offerPrice.currency ?? og.currency ?? amzFallback?.currency ?? 'USD';
  const available    = offerPrice.available;

  const rating       = primary?.aggregateRating?.ratingValue ? Number(primary.aggregateRating.ratingValue) : null;
  const ratingCount  = primary?.aggregateRating?.reviewCount || primary?.aggregateRating?.ratingCount
    ? Number(primary.aggregateRating.reviewCount || primary.aggregateRating.ratingCount) : null;

  const images       = [...new Set([...asImageArray(primary?.image), ...og.images])].filter(Boolean);

  if (!name) {
    console.error('\n✗ Could not extract a product name from this URL.');
    console.error('  This usually means the page is JS-rendered, behind a captcha, or not a product page.');
    console.error('  Try DRY_RUN=1 to see what was found, or paste the data manually in Strapi admin.');
    process.exit(2);
  }

  console.log('\n--- Extracted ---');
  console.log(`  name:        ${name}`);
  console.log(`  brand:       ${brand ?? '(none)'}`);
  console.log(`  sku/mpn:     ${sku ?? '(none)'}`);
  console.log(`  asin:        ${asin ?? '(none)'}`);
  console.log(`  price:       ${currentPrice ?? '(none)'} ${currency || ''}`);
  console.log(`  rating:      ${rating ?? '(none)'} (${ratingCount ?? 0} reviews)`);
  console.log(`  available:   ${available ?? '(unknown)'}`);
  console.log(`  description: ${description?.slice(0, 80) ?? '(none)'}`);
  console.log(`  images:      ${images.length}`);

  if (DRY_RUN) { console.log('\n(DRY_RUN — exiting)'); return; }

  // Upload images
  console.log('\nUploading images...');
  let primaryImageId = null;
  const galleryIds = [];
  for (let i = 0; i < Math.min(images.length, 6); i++) {
    try {
      const up = await uploadImage(images[i], name);
      console.log(`  ✓ ${images[i].slice(0, 80)}  →  /uploads/...${up.url.slice(-40)}`);
      if (i === 0) primaryImageId = up.id;
      else galleryIds.push(up.id);
    } catch (e) {
      console.warn(`  ✗ ${images[i].slice(0, 80)} — ${e.message}`);
    }
  }

  // Assemble + create
  const slug = slugify(name);
  const sourceUrl = URL_ARG;
  const primaryAffiliateUrl = (merchant === 'amazon' || merchant.startsWith('amazon-'))
    ? withAmazonTag(URL_ARG, AMAZON_TAG)
    : URL_ARG;

  const data = {
    name,
    slug,
    brand: brand?.slice(0, 80),
    shortDescription: description?.slice(0, 320),
    description,
    primaryImage: primaryImageId,
    gallery: galleryIds,
    asin: asin?.slice(0, 30),
    skuOrModel: sku?.slice(0, 80),
    currentPrice: currentPrice ?? undefined,
    currency: currency ?? 'USD',
    available: available ?? true,
    rating: rating ?? undefined,
    ratingCount: ratingCount ?? undefined,
    primaryAffiliateUrl,
    sourceUrl,
    sourceMerchant: merchant,
    lastPriceSyncAt: new Date().toISOString(),
  };

  console.log('\nCreating Strapi entry...');
  // Idempotency: dedupe by sourceUrl (treat the same URL as the same product)
  const existing = await strapi(`/api/bls-products?filters[sourceUrl][$eq]=${encodeURIComponent(sourceUrl)}&pagination[pageSize]=1`);
  if (existing.data && existing.data[0]) {
    const docId = existing.data[0].documentId;
    await strapi(`/api/bls-products/${docId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    });
    console.log(`  ✓ updated existing entry (documentId=${docId})`);
  } else {
    const created = await strapi('/api/bls-products', {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    console.log(`  ✓ created (id=${created.data?.id}, documentId=${created.data?.documentId})`);
  }
  console.log(`\nView in Strapi: ${STRAPI_URL}/admin → BLS · Product`);
}

main().catch((e) => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
