#!/usr/bin/env node
/**
 * Generate and attach a cover image to an existing post that has none.
 *
 *   node add-cover.mjs <slug>                       # nxtsmarthome.com.au (default)
 *   node add-cover.mjs <slug> --site bestlooking.skin
 *   node add-cover.mjs <slug> --force               # replace an existing cover
 *   node add-cover.mjs <slug> --dry-run             # show the prompt, write nothing
 *
 * For posts saved without images (--no-images, or a fal.ai failure such as an
 * exhausted balance: the generator then saves the post without a cover).
 * Touches the cover field and nothing else.
 *
 * Keeps the post's state: a published post gets the cover on its published
 * version (visible on the site within ~5 minutes); a draft-only post gets it
 * on the draft, and stays a draft.
 *
 * The prompt depicts no recognisable or branded product, and no text: a
 * photoreal shot of a specific product beside the article would imply someone
 * photographed or tested it.
 */
import 'dotenv/config';
import { fal } from '@fal-ai/client';

const SITES = {
  'nxtsmarthome.com.au': {
    endpoint: '/api/nxtsmarthome-posts',
    prompt: (title) => `Editorial photograph for an Australian smart home article titled "${title}". A bright, modern Australian home interior with plain, unbranded smart home devices where relevant, warm natural daylight, shallow depth of field, clean minimal styling. No text, no logos, no brand names, no recognisable products.`,
  },
  'bestlooking.skin': {
    endpoint: '/api/bls-posts',
    prompt: (title) => `Editorial skincare photograph illustrating "${title}". Minimal flat lay on a clean neutral surface, soft morning daylight, muted tones, shallow depth of field. No text, no logos, no branded or labelled products.`,
  },
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
};
const slug = args.find((a) => !a.startsWith('--') && a !== flag('site'));
const siteKey = flag('site') || 'nxtsmarthome.com.au';
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const site = SITES[siteKey];

if (!slug || !site) {
  console.error(`Usage: node add-cover.mjs <slug> [--site ${Object.keys(SITES).join('|')}] [--force] [--dry-run]`);
  process.exit(1);
}

const STRAPI = (process.env.STRAPI_INTERNAL_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN;
if (!TOKEN) { console.error('STRAPI_API_TOKEN missing in .env'); process.exit(1); }

async function api(path, init = {}) {
  const res = await fetch(`${STRAPI}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const q = (status) => `${site.endpoint}?status=${status}&filters[slug][$eq]=${encodeURIComponent(slug)}&fields[0]=title&populate[coverImage][fields][0]=url`;
const published = (await api(q('published'))).data?.[0];
const draft = (await api(q('draft'))).data?.[0];
const post = published || draft;
if (!post) { console.error(`No ${siteKey} post with slug "${slug}"`); process.exit(1); }

const state = published ? 'published' : 'draft';
console.log(`post  : ${post.title} (${state})`);
if (post.coverImage && !FORCE) {
  console.log(`cover : already set (${post.coverImage.url}) - pass --force to replace`);
  process.exit(0);
}

const prompt = site.prompt(post.title);
console.log(`prompt: ${prompt}`);
if (DRY) { console.log('dry run - nothing generated or written'); process.exit(0); }

if (!process.env.FAL_KEY) { console.error('FAL_KEY missing in .env'); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });
const out = await fal.subscribe('fal-ai/flux/dev', {
  input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true, num_inference_steps: 32 },
});
const url = out?.data?.images?.[0]?.url;
if (!url) { console.error('fal returned no image'); process.exit(1); }

const img = await fetch(url);
const alt = post.title.slice(0, 180);
const form = new FormData();
form.append('files', new Blob([Buffer.from(await img.arrayBuffer())], { type: img.headers.get('content-type') || 'image/jpeg' }), `${slug.slice(0, 60)}-cover.jpg`);
form.append('fileInfo', JSON.stringify({ alternativeText: alt }));
const up = await fetch(`${STRAPI}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
if (!up.ok) { console.error(`upload failed ${up.status}: ${(await up.text()).slice(0, 200)}`); process.exit(1); }
const [asset] = await up.json();
console.log(`upload: #${asset.id} ${asset.url}`);

// Same state as before: published stays published, draft stays draft.
await api(`${site.endpoint}/${post.documentId}?status=${state}`, {
  method: 'PUT',
  body: JSON.stringify({ data: { coverImage: asset.id } }),
});
console.log(`done  : cover attached to the ${state} post${state === 'published' ? ' (on the site within ~5 minutes)' : ''}`);
