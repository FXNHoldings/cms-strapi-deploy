/**
 * Replace a product's featured image with the best one available.
 *
 *   node scripts/fetch-featured-image.mjs --slug=<product-slug>
 *   node scripts/fetch-featured-image.mjs --slug=<slug> --write
 *   node scripts/fetch-featured-image.mjs --category=<slug> --min-pixels=250000 --write
 *
 * The sourcing pipeline stores whatever Google Shopping returns, which is an
 * `encrypted-tbn*.gstatic.com` thumbnail — typically a few hundred pixels and
 * under 20KB once re-encoded. Fine as a placeholder, poor as a hero image.
 *
 * Candidates are gathered from, in order of expected quality:
 *
 *   1. og:image / twitter:image on the storefront page product_info points at
 *   2. the same tags on any offer that carries a real product URL
 *   3. the gstatic images product_info lists
 *
 * Every candidate is actually downloaded and measured; the one with the largest
 * pixel area wins. Sources are not assumed to be better than one another,
 * because a retailer page can just as easily serve a small sprite.
 *
 * Nothing is replaced unless the winner beats what is already stored.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const SLUG = flag('slug', null);
const CATEGORY = flag('category', null);
const MIN_PIXELS = Number(flag('min-pixels', 0));
const PRIORITY = Number(flag('priority', 2));
const LOCATION = Number(flag('location', 2840));
const LANGUAGE = flag('language', 'en');

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const EP = 'https://api.dataforseo.com/v3/merchant/google/product_info';

/* A retailer that thinks it is talking to a script will often serve a 403. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

if (!SLUG && !CATEGORY) { console.error('usage: --slug=<product> | --category=<slug> [--write]'); process.exit(1); }

function authHeader() {
  const pw = DFS_PASSWORD.trim();
  if (/^[A-Za-z0-9+/=]+$/.test(pw) && pw.length > 16) {
    try {
      const [l, ...rest] = Buffer.from(pw, 'base64').toString('utf8').split(':');
      if (rest.length && l.includes('@')) return `Basic ${pw}`;
    } catch { /* not base64 */ }
  }
  return `Basic ${Buffer.from(`${DFS_LOGIN}:${pw}`).toString('base64')}`;
}

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/* ------------------------------------------------------- image measurement */

/**
 * Width and height straight from the file header — no image library needed, and
 * no decoding of an untrusted payload beyond reading a few offsets.
 */
function imageSize(buf) {
  // PNG: IHDR is always the first chunk.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  }
  // GIF
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), type: 'gif' };
  }
  // WebP: VP8 / VP8L / VP8X each store the size differently.
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1, type: 'webp' };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, type: 'webp' };
    }
  }
  // JPEG: walk the segment chain to the start-of-frame marker.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), type: 'jpeg' };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

async function measure(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return null;
    const size = imageSize(buf);
    if (!size?.w || !size?.h) return null;
    return { url, buf, ...size, bytes: buf.length, pixels: size.w * size.h };
  } catch { return null; }
}

/** og:image / twitter:image from a storefront page. */
async function pageImages(pageUrl) {
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const html = (await res.text()).slice(0, 400_000);
    const found = new Set();
    for (const re of [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi,
    ]) {
      for (const m of html.matchAll(re)) {
        const raw = m[1];
        if (!raw || raw.startsWith('data:')) continue;
        found.add(raw.startsWith('//') ? `https:${raw}` : new URL(raw, pageUrl).href);
      }
    }
    return [...found];
  } catch { return []; }
}

async function productInfo(gpid) {
  const post = await fetch(`${EP}/task_post`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{ product_id: gpid, location_code: LOCATION, language_code: LANGUAGE, priority: PRIORITY }]),
    signal: AbortSignal.timeout(120_000),
  });
  const id = (await post.json()).tasks?.[0]?.id;
  if (!id) return null;
  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 8000));
    try {
      const r = await fetch(`${EP}/task_get/advanced/${id}`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(60_000) });
      const text = await r.text();
      if (r.ok && text.trim().startsWith('{')) {
        const t = JSON.parse(text).tasks?.[0];
        if (t?.status_code === 20000) return t.result?.[0]?.items?.[0] ?? null;
        if (t && t.status_code !== 40602) return null;
      }
    } catch { /* keep polling */ }
    if (Date.now() > deadline) return null;
  }
}

async function uploadImage(buf, type, name) {
  const ext = type === 'png' ? 'png' : type === 'webp' ? 'webp' : type === 'gif' ? 'gif' : 'jpg';
  const mime = type === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  const form = new FormData();
  form.append('files', new Blob([buf], { type: mime }), `${name}.${ext}`);
  const up = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form,
  });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 140)}`);
  return (await up.json())[0]?.id ?? null;
}

/* --------------------------------------------------------------------- main */

const q = new URLSearchParams({ 'pagination[pageSize]': '200', status: 'published' });
if (SLUG) q.append('filters[slug][$eq]', SLUG);
else q.append('filters[categories][slug][$eq]', CATEGORY);
q.append('populate[primaryImage][fields][0]', 'url');
q.append('populate[primaryImage][fields][1]', 'width');
q.append('populate[primaryImage][fields][2]', 'height');
q.append('populate[offers][fields][0]', 'productUrl');

const list = await strapi(`/api/commerce-products?${q}`);
let products = list?.data ?? [];
if (MIN_PIXELS) {
  products = products.filter((p) => {
    const px = (p.primaryImage?.width ?? 0) * (p.primaryImage?.height ?? 0);
    return !px || px < MIN_PIXELS;
  });
}
console.log(`products : ${products.length}`);
console.log(`mode     : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);

let replaced = 0, kept = 0;
for (const p of products) {
  const currentPixels = (p.primaryImage?.width ?? 0) * (p.primaryImage?.height ?? 0);
  console.log(`${p.slug}`);
  console.log(`   current: ${p.primaryImage ? `${p.primaryImage.width}x${p.primaryImage.height}` : '(none)'}`);

  const info = p.googleProductId ? await productInfo(p.googleProductId) : null;

  // Real storefront pages first, then the offers, then Google's thumbnails.
  const pages = [
    info?.url,
    ...(info?.sellers ?? []).map((s) => s.url),
    ...(p.offers ?? []).map((o) => o.productUrl),
  ].filter((u) => u && !/\/search|[?&]q=|_nkw=|searchTerm=|keyword=/i.test(u));

  const candidates = new Set();
  for (const page of [...new Set(pages)].slice(0, 4)) {
    for (const img of await pageImages(page)) candidates.add(img);
  }
  for (const img of info?.images ?? []) candidates.add(img);

  const measured = (await Promise.all([...candidates].slice(0, 14).map(measure))).filter(Boolean);
  measured.sort((a, b) => b.pixels - a.pixels);

  if (!measured.length) { console.log('   no usable candidate found\n'); continue; }
  for (const m of measured.slice(0, 4)) {
    console.log(`   cand: ${String(m.w).padStart(4)}x${String(m.h).padEnd(4)} ${String(Math.round(m.bytes / 1024)).padStart(4)}KB ${m.type.padEnd(4)} ${m.url.slice(0, 58)}`);
  }

  const best = measured[0];
  if (best.pixels <= currentPixels) { kept += 1; console.log('   existing image is already as good — keeping it\n'); continue; }

  if (!WRITE) { console.log(`   would replace with ${best.w}x${best.h}\n`); continue; }

  const id = await uploadImage(best.buf, best.type, p.slug);
  if (!id) { console.log('   upload failed\n'); continue; }
  await strapi(`/api/commerce-products/${p.documentId}?status=published`, {
    method: 'PUT',
    body: JSON.stringify({ data: { primaryImage: id, imageUrl: best.url } }),
  });
  replaced += 1;
  console.log(`   replaced with ${best.w}x${best.h}\n`);
}

console.log(`${WRITE ? 'replaced' : 'would replace'} ${replaced} image(s); kept ${kept} already-better image(s).`);
