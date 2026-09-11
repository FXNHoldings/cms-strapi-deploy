#!/usr/bin/env node
/**
 * Upload each product's `imageUrl` into Strapi media and set it as
 * `primaryImage`.
 *
 *   node scripts/backfill-product-images.mjs --category=hyaluronic-acid          # dry run
 *   node scripts/backfill-product-images.mjs --category=hyaluronic-acid --write
 *
 * The iHerb import stored the image as a URL on the retailer's CDN. That is not
 * what the storefront reads: ProductCard resolves `primaryImage`, the media
 * relation, so a product with only `imageUrl` renders a card with no image --
 * 72 of them in the Hyaluronic Acid category.
 *
 * Uploading rather than teaching the card to fall back to the string, for two
 * reasons. The 218 products that already work are all media relations, so a
 * fallback would leave two conventions in one collection. And a hotlink to a
 * retailer CDN is theirs to break: it can be blocked, rewritten, or expire
 * whenever they like, and it leaks our readers to their logs on every
 * page view.
 *
 * Images are fetched from the CDN directly -- no ZenRows. The image host serves
 * without the bot defences the product pages have, which is worth knowing
 * before paying for 72 rendered fetches.
 */
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
const CATEGORY = flag('category', null);
const TAG = flag('tag', null);
const LIMIT = Number(flag('limit', Infinity));
const CONCURRENCY = Number(flag('concurrency', 4));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
if (!TOKEN) { console.error('STRAPI_API_TOKEN not set'); process.exit(2); }
if (!CATEGORY && !TAG) { console.error('one of --category or --tag is required'); process.exit(2); }

async function api(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${pathname} -> ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

const slugify = (s) => String(s).toLowerCase().normalize('NFKD')
  .replace(/[^\w\s-]/g, ' ').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 70);

/** Sniff the real type from magic bytes: the CDN serves f_auto, so the URL
    extension says jpg while the body is often webp. */
function imageType(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xd8) return ['jpg', 'image/jpeg'];
  if (b[0] === 0x89 && b[1] === 0x50) return ['png', 'image/png'];
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return ['webp', 'image/webp'];
  if (b[0] === 0x47 && b[1] === 0x49) return ['gif', 'image/gif'];
  return null;
}

/**
 * iHerb's CDN serves the same image at several sizes, chosen by a path segment:
 * /s/ thumbnail, /m/ medium, /g/ gallery, /l/ large. The category listing gives
 * the /m/ URL, which is 200x200 -- fine for the listing row it was meant for,
 * soft in a product card.
 *
 * So try /l/ first and fall back down. Not every product has every size, and a
 * missing one returns a zero-length body rather than a 404, hence the length
 * check rather than res.ok alone.
 */
async function fetchBestImage(url) {
  const candidates = /\/images\/[^/]+\/[^/]+\/m\//.test(url)
    ? [url.replace(/\/m\//, '/l/'), url.replace(/\/m\//, '/g/'), url]
    : [url];
  let last = null;
  /* Keep why each size failed. Swallowing these made a real failure read as
     "no image returned at any size", which says nothing about the cause. */
  const problems = [];
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) { problems.push(`HTTP ${res.status}`); continue; }
      const buf = await res.arrayBuffer();
      if (buf.byteLength >= 4096) return buf;
      problems.push(`${buf.byteLength}b`);
      if (buf.byteLength > (last?.byteLength ?? 0)) last = buf;
    } catch (err) { problems.push(err.message); }
  }
  if (!last) throw new Error(`no usable image (${problems.join('; ') || 'no candidates'})`);
  return last;
}

async function uploadImage(buf, name) {
  const sniffed = imageType(buf);
  if (!sniffed) throw new Error('not an image');
  const [ext, mime] = sniffed;
  const form = new FormData();
  form.append('files', new Blob([buf], { type: mime }), `${name}.${ext}`);
  const up = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form,
  });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 140)}`);
  return (await up.json())[0]?.id ?? null;
}

/* ------------------------------------------------------------------ select */
const rows = [];
for (let page = 1; ; page += 1) {
  const q = new URLSearchParams({ 'pagination[page]': String(page), 'pagination[pageSize]': '100' });
  if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
  if (TAG) q.append('filters[tags][$containsi]', TAG);
  q.append('fields[0]', 'name'); q.append('fields[1]', 'imageUrl'); q.append('fields[2]', 'slug');
  q.append('populate[primaryImage][fields][0]', 'url');
  const res = await api(`/api/commerce-products?${q}`);
  rows.push(...(res?.data ?? []));
  if (page >= (res?.meta?.pagination?.pageCount ?? 1)) break;
}

const targets = rows
  .filter((p) => (p.imageUrl || '').startsWith('http'))
  .filter((p) => FORCE || !p.primaryImage)
  .slice(0, LIMIT);

console.log(`${rows.length} products in scope; ${rows.filter((p) => p.primaryImage).length} already have a primaryImage; ${targets.length} to upload`);
if (!targets.length) process.exit(0);
if (!WRITE) { console.log('\n[dry-run] nothing uploaded. Re-run with --write.'); process.exit(0); }

let done = 0; let failed = 0; let cursor = 0;
async function worker() {
  for (;;) {
    const i = cursor; cursor += 1;
    if (i >= targets.length) return;
    const p = targets[i];
    try {
      const buf = await fetchBestImage(p.imageUrl);
      if (buf.byteLength < 1024) throw new Error(`image too small (${buf.byteLength}b)`);
      const id = await uploadImage(buf, slugify(p.slug || p.name));
      if (!id) throw new Error('upload returned no id');
      await api(`/api/commerce-products/${p.documentId}`, {
        method: 'PUT', body: JSON.stringify({ data: { primaryImage: id } }),
      });
      done += 1;
      console.log(`  ok  ${(buf.byteLength / 1024).toFixed(0)}kb  ${p.name.slice(0, 46)}`);
    } catch (err) {
      failed += 1;
      console.error(`  ERR ${p.name.slice(0, 46)}: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
console.log(`\nuploaded ${done}, failed ${failed}`);
