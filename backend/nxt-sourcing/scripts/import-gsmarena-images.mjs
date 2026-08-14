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
const MEDIA_ORIGIN = process.env.NXT_MEDIA_ORIGIN || 'https://cms.fxnstudio.com';

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

/**
 * The URL to download for a product, best source first.
 *
 * The GSMArena spec sheets were the original source, but they are not the only
 * one: the sourcing pipeline stores whatever Google Shopping returned in the
 * `imageUrl` column, and for products that never got a spec sheet that column is
 * the only reference there is. Of the 40 products currently missing a featured
 * image, 29 have an `imageUrl` and none have a spec-sheet URL — reading only the
 * spec tree found nothing to do.
 *
 * These are not interchangeable in quality, which is why the MIN_DIMENSION guard
 * applies to both: spec-sheet URLs are 160x212 catalogue thumbnails, while the
 * gstatic ones measured between 168x299 and 659x659.
 */
function sourceUrlFor(product) {
  const fromSpecs = imageUrlFrom(product.specs);
  if (fromSpecs) return fromSpecs;
  const stored = String(product.imageUrl ?? '').trim();
  return /^https?:\/\//i.test(stored) ? stored : null;
}

/**
 * Full-resolution alternatives to a GSMArena "bigpic" URL, best first.
 *
 * bigpic serves a 160x212 catalogue thumbnail, which the dimension guard rightly
 * rejects. The same photo exists at full size under a different path:
 *
 *   .../vv/bigpic/oneplus-15r.jpg  ->  .../vv/pics/oneplus/oneplus-15r-1.jpg
 *
 * That is 655x650 rather than 160x212. The brand directory is the filename's
 * first token, which is how GSMArena names these files.
 *
 * Two rewrites are needed before the guess lands, both seen in this catalogue:
 * bigpic names often carry trailing hyphens where a suffix was trimmed
 * ("google-pixel-9-"), and some carry a revision marker that the pics path does
 * not use ("oneplus-12r-new", "samsung-galaxy-s24-fe-r1"). Applying both takes
 * this from 29 of 40 URLs resolving to 37 of 40.
 *
 * The original bigpic URL is returned last. It will normally be rejected as too
 * small, which is the correct outcome -- but if a product only exists as a
 * thumbnail, --min-dimension can still be lowered deliberately.
 */
function gsmarenaCandidates(url) {
  const m = /^(https?:\/\/[^/]+)\/vv\/bigpic\/(.+)\.jpg$/i.exec(url);
  if (!m) return [url];
  const [, origin, rawName] = m;
  const brand = rawName.split('-')[0];
  const trimmed = rawName.replace(/-+$/, '');
  const noRevision = trimmed.replace(/-(new|r1|rt)$/, '');

  const names = [...new Set([trimmed, noRevision])].filter(Boolean);
  return [...names.map((n) => `${origin}/vv/pics/${brand}/${n}-1.jpg`), url];
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
  /*
   * WebP. This used to return 0x0, and the caller reads a zero as "cannot
   * measure, let it through" -- so the dimension guard was inert for exactly the
   * format Google Shopping serves. Two products picked up 168x299 and 281x363
   * heroes that way, which is the downgrade the guard exists to prevent.
   *
   * Three chunk layouts, all little-endian:
   *   VP8  lossy     14-bit w/h at 26 and 28
   *   VP8L lossless  14-bit w/h packed into 4 bytes at 21
   *   VP8X extended  24-bit canvas size minus one at 24 and 27
   */
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length > 30) {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
    }
    if (chunk === 'VP8L' && buf.length > 25) {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (chunk === 'VP8X' && buf.length > 30) {
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { w: w + 1, h: h + 1, type: 'webp' };
    }
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
  .map((p) => ({ product: p, url: sourceUrlFor(p) }))
  .filter((c) => c.url)
  .filter((c) => OVERWRITE || !c.product.primaryImage)
  .slice(0, LIMIT);

console.log(`products with a usable image url : ${candidates.length}`);
console.log(`mode : ${WRITE ? 'WRITE' : 'DRY RUN'}${OVERWRITE ? ' (overwrite)' : ''}\n`);
if (!candidates.length) process.exit(0);

let done = 0, failed = 0, tooSmall = 0;
for (const { product, url } of candidates) {
  process.stdout.write(`${product.slug.slice(0, 42).padEnd(44)}`);
  if (!WRITE) { console.log(`would fetch ${url.slice(-42)}`); continue; }
  try {
    /*
     * Walk the candidates and keep the first that downloads and clears the
     * dimension floor, so a full-size photo is preferred over the thumbnail
     * without giving up on products that only have the thumbnail.
     */
    let buf = null; let size = null; let lastReject = null;
    for (const candidate of gsmarenaCandidates(url)) {
      let attempt = null;
      try {
        const res = await fetch(candidate, { headers: HEADERS, signal: AbortSignal.timeout(45_000) });
        if (!res.ok) { lastReject = `HTTP ${res.status}`; continue; }
        attempt = Buffer.from(await res.arrayBuffer());
      } catch (e) { lastReject = String(e.message).slice(0, 40); continue; }

      const measured = imageSize(attempt);
      if (!measured) { lastReject = 'unrecognised image format'; continue; }
      const edge = Math.max(measured.w || 0, measured.h || 0);
      if (attempt.length < 4000 || (edge && edge < MIN_DIMENSION)) {
        lastReject = `${measured.w || '?'}x${measured.h || '?'}, below ${MIN_DIMENSION}px`;
        continue;
      }
      buf = attempt; size = measured; break;
    }

    if (!buf) {
      if (/below|x/.test(String(lastReject))) {
        tooSmall += 1;
        console.log(`skipped — ${lastReject}`);
      } else {
        failed += 1;
        console.log(`FAILED ${lastReject}`);
      }
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
