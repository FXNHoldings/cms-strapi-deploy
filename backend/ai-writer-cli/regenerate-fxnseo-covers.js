/**
 * Regenerate cover images for fxnSEOTools posts, one visual concept per article.
 *
 *   node regenerate-fxnseo-covers.js              # dry run, prints the prompts
 *   node regenerate-fxnseo-covers.js --write
 *   node regenerate-fxnseo-covers.js --write --slug=<slug>
 *   node regenerate-fxnseo-covers.js --write --only-missing
 *
 * Why this exists rather than `generate-fxnseo-post.js --add-images`:
 *
 *   1. That flag only fills in posts with NO cover, so it cannot refresh one.
 *   2. It sends the identical prompt for every article — "a laptop showing
 *      analytics dashboards" — so six posts ended up with six near-identical
 *      images. The subject here is derived from the post's own title.
 *   3. Its native-blog update runs `sumoseo-import-post.php` at a local path.
 *      On this machine that path is a DISABLED copy of the site with its own
 *      database, so the write silently goes nowhere and is reported as
 *      "skipped". This script writes over SSH to the live host instead.
 *
 * Variation is seeded from the slug, not from Math.random, so re-running for one
 * post reproduces its look instead of rolling a different scene each time.
 */
import 'dotenv/config';
import { fal } from '@fal-ai/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = args.includes('--write');
const ONLY_MISSING = args.includes('--only-missing');
const SLUG = flag('slug', null);
const MODEL = flag('model', 'fal-ai/flux/schnell');

const STRAPI_URL = (process.env.STRAPI_URL || process.env.STRAPI_INTERNAL_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
/** Public origin the live site must be able to load the image from. */
const MEDIA_ORIGIN = process.env.FXNSEO_MEDIA_ORIGIN || 'https://strapi.fxnstudio.com';
/** The live SumoSEO install. The copy on this box is disabled — see header. */
const LIVE_HOST = process.env.FXNSEO_LIVE_HOST || 'root@178.105.206.112';
const LIVE_APP_DIR = process.env.FXNSEO_LIVE_APP_DIR || '/var/www/html/fxnseo.com/components';

if (!process.env.FAL_KEY) { console.error('FAL_KEY is not set in .env'); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });

/* ---------------------------------------------------------------- prompting */

/**
 * Subject matter keyed off words in the title. First match wins, so the more
 * specific topics are listed before the generic ones.
 */
const CONCEPTS = [
  [/backlink|link build/i, 'a glowing network of interconnected nodes and link chains arcing between two websites, one link visibly broken and faded to show a lost connection'],
  [/sitemap/i, 'a branching tree diagram of site pages rendered as glowing architectural blueprint lines, hierarchy fanning out from a single root'],
  [/robots\.?txt|crawl/i, 'a small friendly robot at a gated doorway, some paths lit and open, others closed with subtle barrier markers'],
  [/meta tag|meta descri/i, 'a magnified search result card floating above a desk, its title and snippet lines rendered as crisp abstract bars'],
  [/rewrit|content|article/i, 'a document dissolving into flowing particles and reassembling as a cleaner second document beside it'],
  [/keyword|rank/i, 'ascending glass bar charts with a magnifier hovering over the tallest column, search terms implied as abstract glyphs'],
  [/speed|performance|core web/i, 'a speedometer merged with a browser window, needle sweeping into a green zone, motion blur trailing'],
  [/schema|structured data/i, 'nested translucent geometric blocks locking together like a 3D data structure'],
  [/redirect/i, 'a curved arrow of light bending around an obstacle and continuing to a destination marker'],
];

const PALETTES = [
  'cool indigo and cyan with deep navy shadows',
  'warm amber and teal against charcoal',
  'emerald and slate with soft white highlights',
  'violet and electric blue on near-black',
  'muted orange and deep petrol blue',
];

const TREATMENTS = [
  'macro photography, shallow depth of field, soft studio lighting',
  'clean 3D render, matte materials, gentle rim lighting',
  'isometric 3D illustration, soft ambient occlusion',
  'cinematic wide shot, volumetric light, subtle haze',
  'flat-lay overhead composition, crisp even lighting',
];

/** Stable per-slug seed, so one post always renders in its own style. */
function seedFrom(slug) {
  let h = 0;
  for (const ch of String(slug)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function conceptFor(title) {
  for (const [re, concept] of CONCEPTS) if (re.test(title)) return concept;
  return 'an abstract search interface floating above a workspace, data connections radiating outward';
}

function promptFor(title, slug) {
  const seed = seedFrom(slug);
  const palette = PALETTES[seed % PALETTES.length];
  const treatment = TREATMENTS[Math.floor(seed / PALETTES.length) % TREATMENTS.length];
  return [
    `Editorial hero image for an article titled "${title}".`,
    `Subject: ${conceptFor(title)}.`,
    `Colour: ${palette}. Style: ${treatment}.`,
    'Professional colour grade, high detail, generous negative space for a headline overlay.',
    'No readable text, no letters, no numbers, no logos, no watermarks, no human faces.',
  ].join(' ');
}

/* ------------------------------------------------------------------ helpers */

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function generateImage(prompt) {
  const result = await fal.subscribe(MODEL, {
    input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true },
    logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('fal.ai returned no image');
  return url;
}

async function uploadToStrapi(imageUrl, filename) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'image/jpeg';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('files', new Blob([buf], { type }), `${filename}.${ext}`);
  const up = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${STRAPI_TOKEN}` }, body: form,
  });
  if (!up.ok) throw new Error(`upload failed ${up.status}: ${(await up.text()).slice(0, 160)}`);
  return (await up.json())[0];
}

/** Set featured_image on the LIVE SumoSEO post, via its own importer. */
async function setLiveFeaturedImage(slug, url) {
  const payload = JSON.stringify({ slug, featured_image: url, set_featured_image_only: true });
  const tmp = path.join(os.tmpdir(), `fxnseo-cover-${slug}-${process.pid}.json`);
  fs.writeFileSync(tmp, payload);
  try {
    await execFileAsync('scp', ['-q', '-o', 'BatchMode=yes', tmp, `${LIVE_HOST}:/tmp/${path.basename(tmp)}`]);
    const { stdout } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes', LIVE_HOST,
      `chmod 644 /tmp/${path.basename(tmp)} && cd ${LIVE_APP_DIR} && ` +
      `sudo -u www-data php sumoseo-import-post.php /tmp/${path.basename(tmp)}; ` +
      `rm -f /tmp/${path.basename(tmp)}`,
    ], { maxBuffer: 1024 * 1024 });
    const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
    const out = JSON.parse(line);
    if (out.error) throw new Error(out.error);
    return out;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/* --------------------------------------------------------------------- main */

const res = await strapi('/api/fxnseo-posts?populate=coverImage&pagination[pageSize]=100&status=published');
let posts = (res.data ?? []).filter((p) => p.slug && p.title);
if (SLUG) posts = posts.filter((p) => p.slug === SLUG);
if (ONLY_MISSING) posts = posts.filter((p) => !p.coverImage);

console.log(`posts : ${posts.length}`);
console.log(`model : ${MODEL}`);
console.log(`mode  : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);

let done = 0, failed = 0;
for (const p of posts) {
  const prompt = promptFor(p.title, p.slug);
  console.log(`${p.slug}`);
  console.log(`   ${prompt.slice(0, 150)}...`);
  if (!WRITE) { console.log(); continue; }
  try {
    const imgUrl = await generateImage(prompt);
    const media = await uploadToStrapi(imgUrl, `${p.slug}-cover`.slice(0, 60));
    await strapi(`/api/fxnseo-posts/${p.documentId}`, {
      method: 'PUT', body: JSON.stringify({ data: { coverImage: media.id } }),
    });
    const publicUrl = media.url.startsWith('http') ? media.url : `${MEDIA_ORIGIN}${media.url}`;
    const live = await setLiveFeaturedImage(p.slug, publicUrl);
    console.log(`   strapi media=${media.id}  live page=${live.id ?? '?'}  ${publicUrl.slice(-46)}`);
    done += 1;
  } catch (e) {
    failed += 1;
    console.log(`   FAILED: ${String(e.message).slice(0, 160)}`);
  }
  console.log();
}

console.log(`${WRITE ? 'regenerated' : 'would regenerate'} ${done} cover(s)${failed ? `, ${failed} failed` : ''}.`);
