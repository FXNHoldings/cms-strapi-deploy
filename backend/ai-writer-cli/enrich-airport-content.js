#!/usr/bin/env node
// FXN — Generate `about` prose + hero image for one or more airports.
//
// Mirrors the destination generator: Claude for prose, Fal.ai (FLUX) for image,
// upload to Strapi /api/upload, then PUT the airport with both fields.
//
// Reusable — call for any airport by IATA. Skips airports that already have
// content unless --overwrite is passed.
//
// Usage:
//   node enrich-airport-content.js --iata MEL                  # one airport
//   node enrich-airport-content.js --iata MEL,SYD,SIN          # several
//   node enrich-airport-content.js --iata MEL --no-images      # prose only
//   node enrich-airport-content.js --iata MEL --dry-run        # show, don't write
//   node enrich-airport-content.js --iata MEL --overwrite      # replace existing values
//   node enrich-airport-content.js --iata MEL --image-model dev   # higher-quality FLUX

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('iata', { type: 'string', describe: 'Comma-separated IATA codes (e.g. "MEL,SYD")', demandOption: true })
  .option('images', { type: 'boolean', default: true, describe: 'Generate hero image (use --no-images to skip)' })
  .option('image-model', { type: 'string', default: 'dev', choices: ['schnell', 'dev', 'pro'] })
  .option('overwrite', { type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-5-20250929',
  STRAPI_URL,
  STRAPI_API_TOKEN,
  FAL_KEY,
} = process.env;

if (!ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set.');
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
}
if (argv.images && !argv['dry-run'] && !FAL_KEY) {
  fatal('FAL_KEY is not set in .env. Use --no-images to skip.');
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const FAL_MODEL_IDS = {
  schnell: 'fal-ai/flux/schnell',
  dev: 'fal-ai/flux/dev',
  pro: 'fal-ai/flux-pro',
};

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

/* ---------- Claude ---------- */

const ABOUT_SYSTEM = `You write airport encyclopedia entries for an editorial travel blog. Tone: informative, calm, factual — not promotional.

Output MUST be strict JSON with these keys:
{
  "about": string  // Exactly three sections in markdown, separated by blank lines, each preceded by a level-2 heading. Total length 150-200 words.
    //   ## Overview              ~50-65 words. Location (km from city, region/country), the airport's role (primary international gateway / hub for X / regional secondary), brief history (year opened, what it replaced if relevant).
    //   ## Terminals & runways   ~50-65 words. How many terminals and what each is used for, runway count and orientation, operating hours (24/7 vs curfew), notable expansions or current construction.
    //   ## Airlines              ~50-65 words. Hub airlines based here, focus-city carriers, the major international carriers that operate here. Avoid passenger numbers and concrete dates unless universally known.
    // No bullet lists. Plain prose under each heading. Don't invent figures — say "one of the busiest" / "a major hub" if you'd otherwise fabricate.
  "imagePrompt": string  // 30-60 words for FLUX. Aerial or apron view of the airport, daytime, photorealistic, editorial-magazine style. Reference real visual cues (control tower shape, terminal architecture if iconic, surrounding geography). NO text overlays, NO airline logos, NO planes with visible liveries. End with: "cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed".
}

No prose outside the JSON. No code fences.`;

function aboutUserPrompt(airport) {
  return [
    `IATA: ${airport.iata}`,
    `ICAO: ${airport.icao ?? '(unknown)'}`,
    `Name: ${airport.name}`,
    `City: ${airport.city ?? '(unknown)'}`,
    `Country: ${airport.country ?? '(unknown)'}`,
    '',
    'Generate the JSON now.',
  ].join('\n');
}

async function generateContent(airport) {
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: ABOUT_SYSTEM,
    messages: [{ role: 'user', content: aboutUserPrompt(airport) }],
  });
  const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  // Strip code fences if present.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let json;
  try { json = JSON.parse(cleaned); }
  catch (e) {
    throw new Error(`Claude returned non-JSON: ${cleaned.slice(0, 200)}…`);
  }
  if (!json.about || !json.imagePrompt) throw new Error('Claude response missing about/imagePrompt');
  return json;
}

/* ---------- Fal.ai ---------- */

async function generateHeroImage(prompt) {
  const modelId = FAL_MODEL_IDS[argv['image-model']];
  const result = await fal.subscribe(modelId, {
    input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true },
    logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('Fal.ai returned no image URL');
  return url;
}

async function uploadImageToStrapi(imageUrl, filename) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image ${imageUrl}: ${res.status}`);
  const ab = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const name = `${filename}.${ext}`.slice(0, 120);
  const form = new FormData();
  form.append('files', new Blob([ab], { type: contentType }), name);
  const uploadRes = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    body: form,
  });
  if (!uploadRes.ok) throw new Error(`Strapi upload ${uploadRes.status}: ${(await uploadRes.text()).slice(0, 240)}`);
  const json = await uploadRes.json();
  const first = Array.isArray(json) ? json[0] : json;
  if (!first?.id) throw new Error('Strapi upload returned no id');
  return first.id;
}

/* ---------- Per-airport runner ---------- */

async function findAirportByIata(iata) {
  const qs = new URLSearchParams();
  qs.set('filters[iata][$eqi]', iata);
  qs.append('fields[0]', 'id');
  qs.append('fields[1]', 'documentId');
  qs.append('fields[2]', 'name');
  qs.append('fields[3]', 'iata');
  qs.append('fields[4]', 'icao');
  qs.append('fields[5]', 'city');
  qs.append('fields[6]', 'country');
  qs.append('fields[7]', 'about');
  qs.append('populate', 'heroImage');
  qs.set('pagination[pageSize]', '1');
  const r = await strapi(`/api/airports?${qs.toString()}`);
  const a = r.data?.[0];
  if (!a) return null;
  const x = a.attributes ?? a;
  return {
    id: a.id,
    documentId: a.documentId ?? x.documentId,
    iata: x.iata,
    icao: x.icao,
    name: x.name,
    city: x.city,
    country: x.country,
    about: x.about,
    heroImage: x.heroImage ?? a.heroImage,
  };
}

async function processAirport(iata) {
  const apt = await findAirportByIata(iata);
  if (!apt) {
    console.error(`✖ ${iata}: not found in Strapi`);
    return;
  }
  console.log(`\n=== ${apt.iata} ${apt.name} (${apt.city}, ${apt.country}) ===`);

  const hasAbout = apt.about && apt.about.trim().length > 0;
  const hasHero = apt.heroImage != null;
  if (hasAbout && hasHero && !argv.overwrite) {
    console.log('  · already has about + heroImage — skipped (use --overwrite to redo)');
    return;
  }

  // 1. Claude
  process.stdout.write('  · generating about + image prompt … ');
  const t0 = Date.now();
  const content = await generateContent(apt);
  console.log(`${Math.round((Date.now() - t0) / 100) / 10}s`);
  console.log(`    about (${content.about.split(/\s+/).length} words):`);
  console.log(`    "${content.about.slice(0, 200).trim()}…"`);
  console.log(`    image prompt: "${content.imagePrompt.slice(0, 140)}…"`);

  if (argv['dry-run']) {
    console.log('  [DRY RUN] no writes');
    return;
  }

  // 2. Fal.ai → upload
  let heroImageId = null;
  if (argv.images && (!hasHero || argv.overwrite)) {
    process.stdout.write('  · generating hero image … ');
    const t1 = Date.now();
    const url = await generateHeroImage(content.imagePrompt);
    console.log(`${Math.round((Date.now() - t1) / 100) / 10}s`);
    process.stdout.write('  · uploading to Strapi … ');
    heroImageId = await uploadImageToStrapi(url, `airport-${apt.iata.toLowerCase()}-hero`);
    console.log(`media id ${heroImageId}`);
  }

  // 3. PUT airport
  const data = {};
  if (!hasAbout || argv.overwrite) data.about = content.about;
  if (heroImageId) data.heroImage = heroImageId;
  if (Object.keys(data).length === 0) {
    console.log('  · nothing to update');
    return;
  }
  await strapi(`/api/airports/${apt.documentId ?? apt.id}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
  console.log(`  ✓ updated airport ${apt.iata} (${Object.keys(data).join(', ')})`);
}

/* ---------- Main ---------- */

async function main() {
  const codes = argv.iata.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  console.log(`=== FXN airport content (${codes.length} airport${codes.length === 1 ? '' : 's'}) ===`);
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  for (const code of codes) {
    try { await processAirport(code); }
    catch (e) { console.error(`  ✖ ${code}: ${e.message.slice(0, 240)}`); }
  }
}

main().catch((e) => fatal(e.message));
