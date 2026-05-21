#!/usr/bin/env node
// FXN — Generate `description` (intro + 2-paragraph Overview + extras) and a
// `facts` JSON sidebar for each region (continent) destination.
//
// Mirrors enrich-country-content.js but writes to `destinations(type=region)`
// and uses a continent-flavoured prompt + fact schema.
//
// Section structure rendered by the destination page (see
// app/destinations/[slug]/page.tsx → ContinentDestinationPage):
//   (intro paragraph, no heading)            — short, 1-2 sentences
//   ## Overview                              — ONE paragraph of prose (renders right column of about block)
//   ## History and Ancient Civilizations     — ONE paragraph of prose (renders right column of about block, under Overview)
//   ## Travel Notes                          — short paragraph (renders full-width below Countries)
//   ## Interesting Facts About {Region}      — 5-item bullet list, 5-10 words each (renders LEFT col of 2-col grid)
//   ## Top Travel Highlights                 — 5-item bullet list, "Place — short reason" (renders RIGHT col of 2-col grid)
//
// Usage:
//   node enrich-region.js --slugs asia                       # one
//   node enrich-region.js --slugs africa,asia,europe,north-america,oceania,south-america
//   node enrich-region.js --slugs asia --no-images
//   node enrich-region.js --slugs asia --dry-run
//   node enrich-region.js --slugs asia --overwrite

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('slugs', { type: 'string', describe: 'Comma-separated destination slugs (e.g. "asia,europe")', demandOption: true })
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

const ABOUT_SYSTEM = `You write continent encyclopedia entries for an editorial travel blog. Tone: informative, calm, factual — not promotional. No travel-brochure superlatives. Substitute the actual continent name where {REGION} appears.

Output MUST be strict JSON with these keys:
{
  "description": string  // A flowing 1-2 sentence intro paragraph, then a blank line, then exactly FOUR sections in markdown separated by blank lines, each preceded by a level-2 heading. Total length 350-500 words.
    //   (intro paragraph)  ~25-45 words, 1-2 sentences. Paint the continent's character — landscape contrasts, scale, what defines it from the outside. NO heading. Examples of the right tone:
    //     "Africa is a continent of 54 countries spanning roughly 30 million km² — Sahara to Cape, equator to Mediterranean, more linguistic and cultural diversity per capita than anywhere on Earth."
    //     "Asia is the largest continent by both area and population — 4.7 billion people, 49 countries, climates from Arctic tundra to monsoon rainforest, and roughly 60% of humanity in one geographic frame."
    //   ## Overview        EXACTLY ONE paragraph of flowing prose (~80-120 words, NOT two paragraphs). Cover geography + cultural/political composition together: major sub-regions, dominant landmasses, defining rivers/seas, number of countries, dominant linguistic families, what an outsider should know to read a map. Plain prose, no bullets.
    //   ## History and Ancient Civilizations  EXACTLY ONE paragraph of flowing prose (~80-120 words). Walk through the continent's major historical layers — earliest civilisations and what they're known for (pyramids, city-states, trading empires, religious origins), key empires that shaped its political map, the colonial / post-colonial inflection if applicable, and what physical traces (ruins, UNESCO sites, archaeological zones) a modern visitor can still see. Concrete names and dates where confidently known; never fabricate dates. Plain prose, no bullets.
    //   ## Travel Notes    ~50-80 words of flowing prose. Visa picture for major passports across the continent (highly variable — flag that), best seasons (continent often spans multiple climate zones; note the split), currency overlay (single currency areas like EUR, or fragmented), getting around (regional aviation hubs, rail vs. road norms).
    //   ## Interesting Facts About {REGION}  EXACTLY 5 bullet points, each on its own line, each starting with "- " (hyphen + space). Keep each bullet SHORT — strictly 5-10 words, one crisp declarative sentence, headline-style. Facts should be verifiable and surprising — geographic superlatives, historical firsts, demographic records, cultural records. Avoid clichés, do NOT invent statistics.
    //   ## Top Travel Highlights  EXACTLY 5 bullet points, each on its own line, each starting with "- " (hyphen + space). Format: "- {Place name} — {one-line reason it's worth visiting, strictly 6-10 words total per bullet AFTER the em-dash}". Name specific, verifiable, iconic destinations (e.g. "- Marrakech — labyrinthine medina, riads, and souks"). Mix country geographies across the continent.
    // Do NOT add ## Highlights, ## Practical, or any other section. Do not wrap bullets in code fences.
  "facts": object  // Structured continent facts for the right-hand sidebar. ALL fields are optional — OMIT any you are not confident about; do NOT fabricate. Use exactly these keys:
    //   countriesCount   number  — number of sovereign UN-member countries on the continent (54 for Africa, 49 for Asia, etc.)
    //   population       number  — approximate latest UN population estimate, integer
    //   areaKm2          number  — approximate total area in square kilometres, integer
    //   languagesTop     string[] — 3-5 most-spoken languages, in order
    //   currenciesTop    string[] — 3-5 most widely circulated currencies (e.g. ["Euro", "Pound sterling", "Swiss franc"])
    //   largestCountry   string  — country with the largest population
    //   largestByArea    string  — country with the largest land area
    //   highestPoint     string  — highest peak with elevation in metres (e.g. "Mount Everest, 8,849 m")
    //   longestRiver     string  — longest river with length in km (e.g. "Nile, 6,650 km")
    //   timezoneSpan     string  — range of timezones (e.g. "UTC+2 to UTC+12")
    //   subregions       string[] — major sub-regions (e.g. ["Northern Africa", "Sub-Saharan Africa"])
  "imagePrompt": string  // 30-60 words for FLUX. A wide landscape that visually represents the continent at scale. Specific (e.g. "the Serengeti at golden hour with acacia trees and migrating wildebeest" not "African savannah"; "the Himalayan ridge under prayer flags at sunrise" not "Asian mountains"). Photorealistic, editorial-magazine style. NO text overlays, NO flags, NO close-up faces. End with: "cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed".
}

No prose outside the JSON. No code fences.`;

function aboutUserPrompt(region) {
  return [
    `Continent / region name: ${region.name}`,
    `Slug: ${region.slug}`,
    '',
    `Use "${region.name}" exactly where the system prompt says {REGION}`,
    `(e.g. the heading must read: ## Interesting Facts About ${region.name}).`,
    '',
    'Generate the JSON now.',
  ].join('\n');
}

async function generateContent(region) {
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    system: ABOUT_SYSTEM,
    messages: [{ role: 'user', content: aboutUserPrompt(region) }],
  });
  const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let json;
  try { json = JSON.parse(cleaned); }
  catch { throw new Error(`Claude returned non-JSON: ${cleaned.slice(0, 200)}…`); }
  if (!json.description || !json.imagePrompt) throw new Error('Claude response missing description/imagePrompt');
  if (json.facts && typeof json.facts !== 'object') throw new Error('Claude response: facts must be an object');
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

/* ---------- Per-region runner ---------- */

async function findRegionDestinationBySlug(slug) {
  const r = await strapi(
    `/api/destinations?filters[slug][$eq]=${slug}&filters[type][$eq]=region&fields[0]=id&fields[1]=documentId&fields[2]=name&fields[3]=slug&fields[4]=description&fields[5]=facts&populate=heroImage&pagination[pageSize]=1`,
  );
  const a = r.data?.[0];
  if (!a) return null;
  const x = a.attributes ?? a;
  return {
    id: a.id,
    documentId: a.documentId ?? x.documentId,
    name: x.name,
    slug: x.slug,
    description: x.description,
    facts: x.facts,
    heroImage: x.heroImage ?? a.heroImage,
  };
}

async function processRegion(slug) {
  const dest = await findRegionDestinationBySlug(slug);
  if (!dest) {
    console.error(`✖ ${slug}: not found in destinations(type=region)`);
    return;
  }
  console.log(`\n=== ${dest.slug} ${dest.name} ===`);

  const hasDesc = dest.description && dest.description.trim().length > 0;
  const hasHero = dest.heroImage != null;
  const hasFacts = dest.facts && Object.keys(dest.facts).length > 0;
  if (hasDesc && hasHero && hasFacts && !argv.overwrite) {
    console.log('  · already has description + heroImage + facts — skipped (use --overwrite)');
    return;
  }

  process.stdout.write('  · generating description + facts + image prompt … ');
  const t0 = Date.now();
  const content = await generateContent(dest);
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`    description (${content.description.split(/\s+/).length} words):`);
  console.log(`    "${content.description.slice(0, 220).replace(/\n/g, ' ')}…"`);
  if (content.facts) {
    console.log(`    facts: ${Object.keys(content.facts).join(', ')}`);
  } else {
    console.log('    facts: (none returned)');
  }
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
    heroImageId = await uploadImageToStrapi(url, `region-${dest.slug}-hero`);
    console.log(`media id ${heroImageId}`);
  }

  const data = {};
  if (!hasDesc || argv.overwrite) data.description = content.description;
  if ((!hasFacts || argv.overwrite) && content.facts) data.facts = content.facts;
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
  console.log(`=== FXN region content (${slugs.length} ${slugs.length === 1 ? 'region' : 'regions'}) — model ${CLAUDE_MODEL} ===`);
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  for (const slug of slugs) {
    try { await processRegion(slug); }
    catch (e) { console.error(`  ✖ ${slug}: ${e.message.slice(0, 240)}`); }
  }
}

main().catch((e) => fatal(e.message));
