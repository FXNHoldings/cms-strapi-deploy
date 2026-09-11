/**
 * Generate and attach a cover image to bls-post drafts that have none.
 *
 *   node backfill-covers.mjs --site bestlooking.skin            # dry run
 *   node backfill-covers.mjs --site bestlooking.skin --write
 *
 * Exists because the first content run used --no-images, to get articles in
 * front of a reviewer before spending on imagery for posts that might be
 * rewritten. Regenerating those posts to add covers would replace bodies that
 * have since been reviewed, so this touches the cover field and nothing else.
 *
 * Two rules carried over from the generator:
 *
 *   Writes land on the DRAFT version (?status=draft). A plain PUT in Strapi 5
 *   creates a published version, which is how five posts went live while being
 *   reported as drafts.
 *
 *   product-review posts get imagery that depicts no recognisable product. A
 *   photorealistic shot of a labelled bottle beside a review implies someone
 *   photographed the item they tested, and nobody tested anything.
 */
import 'dotenv/config';
import { fal } from '@fal-ai/client';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);
/*
 * Restrict to named slugs. Without it this matched 96 cover-less drafts -- the
 * site's whole back catalogue of unpublished posts, none of which anyone asked
 * for. A backfill that decides its own scope from "everything missing a field"
 * will always be wrong on a CMS someone else has been using.
 */
const ONLY = (args.find((a) => a.startsWith('--slugs=')) || '').split('=')[1];
const ONLY_SET = ONLY ? new Set(ONLY.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const MODEL = 'fal-ai/flux/schnell';

const STRAPI = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN;
if (!TOKEN) { console.error('STRAPI_API_TOKEN missing'); process.exit(1); }
if (!process.env.FAL_KEY) { console.error('FAL_KEY missing'); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });

async function api(path, init = {}) {
  const res = await fetch(`${STRAPI}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function promptFor(post) {
  const title = post.title || post.slug;
  if (post.postType === 'product-review') {
    return `Editorial skincare still life illustrating "${title}". Abstract textures, raw ingredients, or plain UNLABELLED glassware on a clean neutral surface, soft diffused daylight, shallow depth of field, minimal styling, shot on a 50mm lens. Do NOT depict any branded or recognisable product, packaging, or labelled bottle.`;
  }
  return `Editorial skincare photograph illustrating "${title}". Minimal flat lay on a clean neutral surface, soft morning daylight, muted tones, shallow depth of field, no text, no logos, shot on a 50mm lens.`;
}

const drafts = [];
for (let page = 1; ; page += 1) {
  const d = await api(`/api/bls-posts?status=draft&pagination[page]=${page}&pagination[pageSize]=100&fields[0]=slug&fields[1]=title&fields[2]=postType&populate[coverImage][fields][0]=url`);
  drafts.push(...(d.data ?? []));
  if (page >= (d.meta?.pagination?.pageCount ?? 1)) break;
}
let targets = drafts.filter((p) => !p.coverImage);
if (ONLY_SET) targets = targets.filter((p) => ONLY_SET.has(p.slug));
if (LIMIT) targets = targets.slice(0, LIMIT);
if (ONLY_SET) {
  const missing = [...ONLY_SET].filter((s) => !targets.some((p) => p.slug === s));
  if (missing.length) console.log(`note: not matched as cover-less drafts: ${missing.join(', ')}\n`);
}
console.log(`drafts without a cover: ${targets.length}${WRITE ? '' : '  (dry run)'}\n`);

for (const post of targets) {
  const prompt = promptFor(post);
  console.log(`  ${post.slug}  [${post.postType}]`);
  if (!WRITE) { console.log(`     ${prompt.slice(0, 120)}...\n`); continue; }

  const out = await fal.subscribe(MODEL, {
    input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true },
  });
  const url = out?.data?.images?.[0]?.url || out?.images?.[0]?.url;
  if (!url) { console.log('     no image returned, skipped\n'); continue; }

  const img = await fetch(url);
  const blob = new Blob([await img.arrayBuffer()], { type: img.headers.get('content-type') || 'image/jpeg' });
  const form = new FormData();
  form.append('files', blob, `${post.slug}-cover.jpg`.slice(0, 120));
  const up = await fetch(`${STRAPI}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  if (!up.ok) { console.log(`     upload failed ${up.status}\n`); continue; }
  const [asset] = await up.json();

  // ?status=draft -- never create a published version
  await api(`/api/bls-posts/${post.documentId}?status=draft`, {
    method: 'PUT',
    body: JSON.stringify({ data: { coverImage: asset.id } }),
  });
  console.log(`     cover #${asset.id} attached\n`);
}
console.log(WRITE ? 'done.' : 'dry run -- nothing written.');
