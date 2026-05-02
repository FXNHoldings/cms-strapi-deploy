#!/usr/bin/env node
// FXN — Generate hero images for the 6 continent destinations.
//
// One-off script: hand-crafted FLUX prompts (no Claude needed), Fal.ai,
// upload to Strapi, link to the destination by slug.
//
// Usage:
//   node generate-continent-heroes.js              # all 6
//   node generate-continent-heroes.js --slug asia  # one
//   node generate-continent-heroes.js --dry-run    # show prompts, no writes

import 'dotenv/config';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('slug', { type: 'string', describe: 'Run for a single continent slug' })
  .option('image-model', { type: 'string', default: 'dev', choices: ['schnell', 'dev', 'pro'] })
  .option('overwrite', { type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN, FAL_KEY } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
if (!argv['dry-run'] && !FAL_KEY) fatal('FAL_KEY is not set in .env');
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const FAL_MODEL_IDS = {
  schnell: 'fal-ai/flux/schnell',
  dev: 'fal-ai/flux/dev',
  pro: 'fal-ai/flux-pro',
};

/* ---------- Hand-crafted continent prompts ---------- */

const CONTINENTS = [
  {
    slug: 'africa',
    prompt:
      'Sweeping aerial photograph of African savanna at golden hour, scattered acacia trees casting long shadows, distant mountain range in haze, herd of elephants in the middle distance, warm amber and ochre tones, photorealistic editorial travel photography, cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed, no text, no logos',
  },
  {
    slug: 'asia',
    prompt:
      'Aerial photograph of Southeast Asian terraced rice paddies in early morning mist, layered green slopes climbing into a misty valley, distant pagoda silhouette on a hill, soft pastel sunrise tones, photorealistic editorial travel photography, cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed, no text, no logos',
  },
  {
    slug: 'europe',
    prompt:
      'Aerial photograph of a Mediterranean European coastal old town at golden hour, terracotta rooftops and church bell towers, narrow cobblestone streets, harbour with sailing boats, surrounding turquoise sea, warm afternoon light, photorealistic editorial travel photography, cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed, no text, no logos',
  },
  {
    slug: 'north-america',
    prompt:
      'Aerial photograph of the American Southwest at golden hour, dramatic red rock canyons and mesas, winding river below, desert sage and juniper, distant snow-capped peaks on the horizon, sweeping vistas, photorealistic editorial travel photography, cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed, no text, no logos',
  },
  {
    slug: 'oceania',
    prompt:
      'Aerial photograph of a tropical Pacific island in midday sun, turquoise lagoon ringed by coral reef, white sand beach, palm forest interior, cresting wave on the outer reef, deep blue ocean beyond, photorealistic editorial travel photography, cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed, no text, no logos',
  },
  {
    slug: 'south-america',
    prompt:
      'Aerial photograph of Patagonian Andes at sunrise, jagged granite peaks rising above blue glaciers, turquoise alpine lake in the foreground, low clouds drifting between summits, dramatic sky with golden light, photorealistic editorial travel photography, cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed, no text, no logos',
  },
];

/* ---------- Helpers ---------- */

function fatal(m) { console.error('✖', m); process.exit(1); }

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Strapi ${res.status} on ${pathname}: ${(await res.text()).slice(0, 240)}`);
  return res.json();
}

async function findDestinationBySlug(slug) {
  const r = await strapi(`/api/destinations?filters[slug][$eq]=${slug}&populate=heroImage&pagination[pageSize]=1`);
  const a = r.data?.[0];
  if (!a) return null;
  const x = a.attributes ?? a;
  return {
    id: a.id,
    documentId: a.documentId ?? x.documentId,
    name: x.name,
    slug: x.slug,
    heroImage: x.heroImage ?? a.heroImage,
  };
}

async function generateImage(prompt) {
  const result = await fal.subscribe(FAL_MODEL_IDS[argv['image-model']], {
    input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true },
    logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('Fal.ai returned no image URL');
  return url;
}

async function uploadToStrapi(imageUrl, filename) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const ab = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('files', new Blob([ab], { type: contentType }), `${filename}.${ext}`);
  const uploadRes = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    body: form,
  });
  if (!uploadRes.ok) throw new Error(`Upload ${uploadRes.status}: ${(await uploadRes.text()).slice(0, 240)}`);
  const json = await uploadRes.json();
  const first = Array.isArray(json) ? json[0] : json;
  if (!first?.id) throw new Error('Upload returned no id');
  return first.id;
}

/* ---------- Main ---------- */

async function main() {
  const targets = argv.slug ? CONTINENTS.filter((c) => c.slug === argv.slug) : CONTINENTS;
  console.log(`=== Continent hero images (${targets.length}) ===`);
  if (argv['dry-run']) console.log('  [DRY RUN] No images or writes.');

  for (const c of targets) {
    console.log(`\n=== ${c.slug} ===`);
    const dest = await findDestinationBySlug(c.slug);
    if (!dest) { console.error(`  ✖ destination "${c.slug}" not found in Strapi`); continue; }

    if (dest.heroImage && !argv.overwrite) {
      console.log(`  · already has heroImage (id=${dest.heroImage.id ?? '?'}) — skipped (use --overwrite)`);
      continue;
    }

    if (argv['dry-run']) {
      console.log(`  prompt: "${c.prompt.slice(0, 140)}…"`);
      continue;
    }

    process.stdout.write('  · generating … ');
    const t0 = Date.now();
    const url = await generateImage(c.prompt);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);

    process.stdout.write('  · uploading … ');
    const mediaId = await uploadToStrapi(url, `continent-${c.slug}-hero`);
    console.log(`media id ${mediaId}`);

    await strapi(`/api/destinations/${dest.documentId ?? dest.id}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { heroImage: mediaId } }),
    });
    console.log(`  ✓ ${dest.name} hero set`);
  }
}

main().catch((e) => fatal(e.message));
