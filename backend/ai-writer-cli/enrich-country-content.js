#!/usr/bin/env node
// FXN — Generate `description` (3-section markdown) + hero image for one or
// more country destinations.
//
// Mirrors enrich-airport-content.js but writes to `destinations(type=country)`
// matched by slug, and uses a country-flavoured prompt.
//
// Reusable — call for any country by slug. Skips destinations that already
// have description + heroImage unless --overwrite is passed.
//
// Usage:
//   node enrich-country-content.js --slugs thailand                         # one
//   node enrich-country-content.js --slugs thailand,japan,italy,france,australia
//   node enrich-country-content.js --slugs thailand --no-images
//   node enrich-country-content.js --slugs thailand --dry-run
//   node enrich-country-content.js --slugs thailand --overwrite

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('slugs', { type: 'string', describe: 'Comma-separated destination slugs (e.g. "thailand,japan")', demandOption: true })
  .option('images', { type: 'boolean', default: true })
  .option('image-model', { type: 'string', default: 'dev', choices: ['schnell', 'dev', 'pro'] })
  .option('overwrite', { type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
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

const ABOUT_SYSTEM = `You write country encyclopedia entries for an editorial travel blog. Tone: informative, calm, factual — not promotional. No travel-brochure superlatives.

Output MUST be strict JSON with these keys:
{
  "description": string  // Exactly three sections in markdown, separated by blank lines, each preceded by a level-2 heading. Total length 140-200 words.
    //   ## Overview        ~50-65 words. Geography (region, neighbours, coastline if applicable), capital city, official language, currency, broad cultural identity.
    //   ## Highlights      ~50-65 words. The two or three things this country is best known for to travellers — major sights, iconic landscapes, signature food or culture. Concrete, specific. Avoid clichés like "rich tapestry" or "hidden gems".
    //   ## Practical       ~40-60 words. Visa picture (visa-on-arrival / visa-free for major passports if you know it confidently), best season to visit, currency notes, getting around basics.
    // No bullet lists. Plain prose under each heading. Don't fabricate visa details, prices, or population figures — generalise if uncertain.
  "imagePrompt": string  // 30-60 words for FLUX. A landscape or cityscape that visually represents the country. Specific (e.g. "Angkor Wat at sunrise" not "Cambodian temple"; "the Amalfi coast at golden hour" not "Italian coast"). Photorealistic, editorial-magazine style. NO text overlays, NO flags, NO people's faces. End with: "cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed".
}

No prose outside the JSON. No code fences.`;

function aboutUserPrompt(country) {
  return [
    `Country name: ${country.name}`,
    `ISO code: ${country.countryCode ?? '(unknown)'}`,
    '',
    'Generate the JSON now.',
  ].join('\n');
}

async function generateContent(country) {
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: ABOUT_SYSTEM,
    messages: [{ role: 'user', content: aboutUserPrompt(country) }],
  });
  const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let json;
  try { json = JSON.parse(cleaned); }
  catch { throw new Error(`Claude returned non-JSON: ${cleaned.slice(0, 200)}…`); }
  if (!json.description || !json.imagePrompt) throw new Error('Claude response missing description/imagePrompt');
  return json;
}

/* ---------- Fal.ai ---------- */

async function generateHeroImage(prompt) {
  const result = await fal.subscribe(FAL_MODEL_IDS[argv['image-model']], {
    input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true },
    logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('Fal.ai returned no image URL');
  return url;
}

async function uploadImageToStrapi(imageUrl, filename) {
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

/* ---------- Per-country runner ---------- */

async function findCountryDestinationBySlug(slug) {
  const r = await strapi(
    `/api/destinations?filters[slug][$eq]=${slug}&filters[type][$eq]=country&fields[0]=id&fields[1]=documentId&fields[2]=name&fields[3]=slug&fields[4]=countryCode&fields[5]=description&populate=heroImage&pagination[pageSize]=1`,
  );
  const a = r.data?.[0];
  if (!a) return null;
  const x = a.attributes ?? a;
  return {
    id: a.id,
    documentId: a.documentId ?? x.documentId,
    name: x.name,
    slug: x.slug,
    countryCode: x.countryCode,
    description: x.description,
    heroImage: x.heroImage ?? a.heroImage,
  };
}

async function processCountry(slug) {
  const dest = await findCountryDestinationBySlug(slug);
  if (!dest) {
    console.error(`✖ ${slug}: not found in destinations(type=country)`);
    return;
  }
  console.log(`\n=== ${dest.slug} ${dest.name} (${dest.countryCode ?? '?'}) ===`);

  const hasDesc = dest.description && dest.description.trim().length > 0;
  const hasHero = dest.heroImage != null;
  if (hasDesc && hasHero && !argv.overwrite) {
    console.log('  · already has description + heroImage — skipped (use --overwrite)');
    return;
  }

  process.stdout.write('  · generating description + image prompt … ');
  const t0 = Date.now();
  const content = await generateContent(dest);
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`    description (${content.description.split(/\s+/).length} words):`);
  console.log(`    "${content.description.slice(0, 220).replace(/\n/g, ' ')}…"`);
  console.log(`    image prompt: "${content.imagePrompt.slice(0, 140)}…"`);

  if (argv['dry-run']) {
    console.log('  [DRY RUN] no writes');
    return;
  }

  let heroImageId = null;
  if (argv.images && (!hasHero || argv.overwrite)) {
    process.stdout.write('  · generating hero image … ');
    const t1 = Date.now();
    const url = await generateHeroImage(content.imagePrompt);
    console.log(`${((Date.now() - t1) / 1000).toFixed(1)}s`);
    process.stdout.write('  · uploading to Strapi … ');
    heroImageId = await uploadImageToStrapi(url, `country-${dest.slug}-hero`);
    console.log(`media id ${heroImageId}`);
  }

  const data = {};
  if (!hasDesc || argv.overwrite) data.description = content.description;
  if (heroImageId) data.heroImage = heroImageId;
  if (Object.keys(data).length === 0) {
    console.log('  · nothing to update');
    return;
  }
  await strapi(`/api/destinations/${dest.documentId ?? dest.id}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
  console.log(`  ✓ updated ${dest.slug} (${Object.keys(data).join(', ')})`);
}

/* ---------- Main ---------- */

async function main() {
  const slugs = argv.slugs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  console.log(`=== FXN country content (${slugs.length} ${slugs.length === 1 ? 'country' : 'countries'}) — model ${CLAUDE_MODEL} ===`);
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  for (const slug of slugs) {
    try { await processCountry(slug); }
    catch (e) { console.error(`  ✖ ${slug}: ${e.message.slice(0, 240)}`); }
  }
}

main().catch((e) => fatal(e.message));
