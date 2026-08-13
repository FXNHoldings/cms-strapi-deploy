/**
 * Download the product photo referenced by the GSMArena specs, store it in
 * Strapi's media library, and set it as the product's featured image.
 *
 *   node scripts/import-gsmarena-images.mjs                    # dry run, all
 *   node scripts/import-gsmarena-images.mjs --write
 *   node scripts/import-gsmarena-images.mjs --write --category=tablets
 *   node scripts/import-gsmarena-images.mjs --write --overwrite # replace existing
 *
 * The spec sheets carry an "Image URL" row pointing at gsmarena.com. That row is
 * hidden from the Specifications table on the product page — it is plumbing, not
 * a specification — so this is what turns it into something visible.
 *
 * The file is uploaded rather than hot-linked. A remote URL on a page we do not
 * control breaks when the host reorganises or blocks us, and gsmarena has been
 * rate-limiting this server all day.
 *
 * By default a product that already has an image is left alone, so this can be
 * re-run safely; --overwrite replaces them.
 */
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const OVERWRITE = args.includes('--overwrite');
const CATEGORY = flag('category', null);
const SLUG = flag('slug', null);
const LIMIT = Number(flag('limit', Infinity));
const DELAY_MS = Number(flag('delay', 900));
/*
 * Minimum long edge, in pixels.
 *
 * Every "bigpic" URL in the GSMArena sheets returns a 160x212 catalogue
 * thumbnail — a real JPEG, around 8-10KB, so a byte-size floor waves it through.
 * Products elsewhere in this catalogue carry 900x900 to 989x1096 images, so
 * these would be a visible downgrade. Dimensions are the only guard that
 * distinguishes them.
 */
const MIN_DIMENSION = Number(flag('min-dimension', 400));

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const MEDIA_ORIGIN = process.env.NXT_MEDIA_ORIGIN || 'https://strapi.fxnstudio.com';

/* gsmarena refuses default clients; a browser UA and a referer get the file. */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Referer: 'https://www.gsmarena.com/',
  Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
};

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

/** Pull the "Image URL" row out of the stored GSMArena spec tree. */
function imageUrlFrom(specs) {
  const groups = specs?.gsmarena?.specifications;
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    for (const row of group?.specifications ?? []) {
      const name = String(row?.name ?? row?.label ?? '').trim().toLowerCase();
      if (name === 'image url' || name === 'image') {
        const value = String(row?.value ?? '').trim();
        if (/^https?:\/\//i.test(value)) return value;
      }
    }
  }
  return null;
}

/** Dimensions from the file header — enough to reject placeholders and icons. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  }
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
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { w: 0, h: 0, type: 'webp' };
  }
  return null;
}

async function uploadToStrapi(buf, type, name) {
  const ext = type === 'png' ? 'png' : type === 'webp' ? 'webp' : 'jpg';
  const mime = type === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  const form = new FormData();
  form.append('files', new Blob([buf], { type: mime }), `${name}.${ext}`);
  const up = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form,
  });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 140)}`);
  return (await up.json())[0];
}

/* --------------------------------------------------------------------- main */

/*
 * Paged rather than one large request. A single pageSize=500 call silently
 * truncated a 699-product catalogue and returned none of the products this
 * script exists to serve — the newest rows sort last.
 */
async function allProducts() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const q = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '200',
      status: 'published',
    });
    q.append('filters[tags][$containsi]', 'nxt-bargains');
    if (CATEGORY) q.append('filters[categories][slug][$eq]', CATEGORY);
    if (SLUG) q.append('filters[slug][$eq]', SLUG);
    q.append('populate[primaryImage][fields][0]', 'url');
    const res = await strapi(`/api/commerce-products?${q}`);
    const batch = res?.data ?? [];
    out.push(...batch);
    const pageCount = res?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount || !batch.length) break;
  }
  return out;
}

const candidates = (await allProducts())
  .map((p) => ({ product: p, url: imageUrlFrom(p.specs) }))
  .filter((c) => c.url)
  .filter((c) => OVERWRITE || !c.product.primaryImage)
  .slice(0, LIMIT);

console.log(`products with a GSMArena image url : ${candidates.length}`);
console.log(`mode : ${WRITE ? 'WRITE' : 'DRY RUN'}${OVERWRITE ? ' (overwrite)' : ''}\n`);
if (!candidates.length) process.exit(0);

let done = 0, failed = 0, tooSmall = 0;
for (const { product, url } of candidates) {
  process.stdout.write(`${product.slug.slice(0, 42).padEnd(44)}`);
  if (!WRITE) { console.log(`would fetch ${url.slice(-42)}`); continue; }
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const size = imageSize(buf);
    if (!size) throw new Error('unrecognised image format');
    // Byte size alone cannot tell a thumbnail from a photo; check the pixels.
    const longEdge = Math.max(size.w || 0, size.h || 0);
    if (buf.length < 4000 || (longEdge && longEdge < MIN_DIMENSION)) {
      tooSmall += 1;
      console.log(`skipped — ${size.w || '?'}x${size.h || '?'}, below ${MIN_DIMENSION}px`);
      continue;
    }

    const media = await uploadToStrapi(buf, size.type, product.slug);
    await strapi(`/api/commerce-products/${product.documentId}?status=published`, {
      method: 'PUT',
      body: JSON.stringify({ data: {
        primaryImage: media.id,
        imageUrl: media.url.startsWith('http') ? media.url : `${MEDIA_ORIGIN}${media.url}`,
      } }),
    });
    done += 1;
    console.log(`${size.w || '?'}x${size.h || '?'}  ${Math.round(buf.length / 1024)}KB  media=${media.id}`);
  } catch (e) {
    failed += 1;
    console.log(`FAILED ${String(e.message).slice(0, 68)}`);
  }
  // Polite pacing: this host has been rate-limiting us all day.
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

console.log(`\n${WRITE ? 'imported' : 'would import'} ${done} image(s)${tooSmall ? `; ${tooSmall} placeholder(s) skipped` : ''}${failed ? `; ${failed} failed` : ''}.`);
