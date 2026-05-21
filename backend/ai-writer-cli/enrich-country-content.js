#!/usr/bin/env node
// FXN — Generate `description` (intro + 3-section markdown with bullet list) +
// hero image for one or more country destinations.
//
// Section structure matches the UK destination page:
//   (intro paragraph, no heading)
//   ## Overview                       — short paragraph        (rendered in About block)
//   ## Visa Requirements              — short paragraph        (rendered in About block)
//   ## Famous Attractions in {Country} — short paragraph       (rendered above Flights)
//   ## Weather & Climate              — short paragraph        (rendered above Flights)
//   ## Interesting Facts About {Country} — 5-item bullet list  (rendered above Flights)
//   ## Official Resources             — 4-6 item bullet list   (rendered above Flights)
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
  "description": string  // A flowing 1-2 sentence intro paragraph, then a blank line, then EXACTLY SIX sections in markdown separated by blank lines, in the order below. Substitute the actual country name where {COUNTRY} appears. Total length 400-600 words.
    //   (intro paragraph)  ~25-45 words, 1-2 sentences. Paint the country's character — landscape contrasts, what defines daily life, a sensory detail. Editorial, confident, never promotional. NO heading. Examples of the right tone:
    //     "Four nations on one island — chalk cliffs, Highland lochs, Welsh valleys and Northern Irish coastline across roughly 244,000 km², home to 68 million people and four capitals."
    //     "Iceland is fire and ice rendered into landscape: glaciers, geysers, black-sand beaches, and skies that flicker green half the year."
    //   ## Overview        ~55-75 words of flowing prose. Geography (region, neighbours, coastline if applicable), capital city, official language, currency, broad cultural identity. No bullets.
    //   ## Visa Requirements  ~30-55 words of flowing prose. Generalise honestly — many travellers visa-free or visa-on-arrival, point to the country's official electronic travel authority / eVisa system if you confidently know its name. Do NOT fabricate specific fees, durations, or nationality lists. Plain prose, no bullets.
    //   ## Famous Attractions in {COUNTRY}  ~50-80 words of flowing prose. Name 4-6 of the country's most iconic, verifiable attractions (landmarks, natural wonders, cultural sites) with one specific detail each. Be concrete (e.g. "Stonehenge on Salisbury Plain") not generic ("ancient ruins"). No bullets.
    //   ## Weather & Climate  ~50-80 words of flowing prose. Climate type, typical summer + winter temperature ranges in °C, best season to visit, regional variation if meaningful, one practical packing note. Use real numbers but don't fabricate specific rainfall figures. No bullets.
    //   ## Interesting Facts About {COUNTRY}  EXACTLY 5 bullet points, each on its own line, each starting with "- " (hyphen + space). Keep each bullet SHORT — strictly 7-10 words, one crisp declarative sentence, ideally headline-style (e.g. "- Home to over 1,500 medieval castles." or "- World's largest exporter of high-grade saffron."). No follow-up explanation, avoid commas mid-sentence unless necessary. Facts should be verifiable and surprising — historical firsts, geographic superlatives, cultural icons, distinctive customs. Avoid clichés, avoid promotional language, do NOT invent statistics.
    //   ## Official Resources  EXACTLY 4-6 bullet points. Each bullet "- domain.tld — short description" naming an official .gov / national tourist board / national transport / weather agency / national rail or transit authority site. Use ONLY real, well-known official domains. Do NOT fabricate URLs. If unsure of a country's specific resource, omit that bullet rather than invent.
    // Do NOT add ## Highlights, ## Practical, or any other section. Do not wrap bullets in code fences.
  "facts": object  // Structured per-country facts rendered in the right-hand sidebar. ALL fields are optional — OMIT any you are not confident about; do NOT fabricate. Use exactly these keys:
    //   officialName    string  — full constitutional name (e.g. "French Republic", "Kingdom of Thailand")
    //   capital         string  — primary capital city
    //   currencyCode    string  — ISO 4217 code, uppercase (e.g. "EUR", "JPY")
    //   currencyName    string  — friendly name (e.g. "Euro", "Japanese yen")
    //   population      number  — most recent UN/national estimate, integer (no commas)
    //   areaKm2         number  — total area in square kilometres, integer
    //   languages       string[] — official / dominant languages in usage order (e.g. ["French"])
    //   government      string  — short form (e.g. "Unitary semi-presidential republic", "Parliamentary constitutional monarchy")
    //   monarch         string  — current head of state IF a monarchy (e.g. "King Charles III"). OMIT for republics.
    //   timezones       string  — short form (e.g. "CET / CEST", "JST (UTC+9)", "UTC−3:30 to −8")
    //   drivesOn        string  — "left" or "right"
    //   callingCode     string  — international dialling prefix with + (e.g. "+33")
  "imagePrompt": string  // 30-60 words for FLUX. A landscape or cityscape that visually represents the country. Specific (e.g. "Angkor Wat at sunrise" not "Cambodian temple"; "the Amalfi coast at golden hour" not "Italian coast"). Photorealistic, editorial-magazine style. NO text overlays, NO flags, NO people's faces. End with: "cinematic lighting, shot on Hasselblad, 16:9 aspect ratio, ultra-detailed".
}

No prose outside the JSON. No code fences.`;

function aboutUserPrompt(country) {
  return [
    `Country name: ${country.name}`,
    `ISO code: ${country.countryCode ?? '(unknown)'}`,
    '',
    `Use "${country.name}" exactly where the system prompt says {COUNTRY}`,
    `(e.g. the heading must read: ## Interesting Facts About ${country.name}).`,
    '',
    'Generate the JSON now.',
  ].join('\n');
}

async function generateContent(country) {
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    system: ABOUT_SYSTEM,
    messages: [{ role: 'user', content: aboutUserPrompt(country) }],
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

/* ---------- Per-country runner ---------- */

async function findCountryDestinationBySlug(slug) {
  const r = await strapi(
    `/api/destinations?filters[slug][$eq]=${slug}&filters[type][$eq]=country&fields[0]=id&fields[1]=documentId&fields[2]=name&fields[3]=slug&fields[4]=countryCode&fields[5]=description&fields[6]=facts&populate=heroImage&pagination[pageSize]=1`,
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
    facts: x.facts,
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
    heroImageId = await uploadImageToStrapi(url, `country-${dest.slug}-hero`);
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
  console.log(`=== FXN country content (${slugs.length} ${slugs.length === 1 ? 'country' : 'countries'}) — model ${CLAUDE_MODEL} ===`);
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  for (const slug of slugs) {
    try { await processCountry(slug); }
    catch (e) { console.error(`  ✖ ${slug}: ${e.message.slice(0, 240)}`); }
  }
}

main().catch((e) => fatal(e.message));
