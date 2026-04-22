#!/usr/bin/env node
// FXN AI Writer — Destinations
// Generates Destination entries (country/region/city) with Claude Sonnet 4.5,
// optional hero image via Fal.ai FLUX, and posts to Strapi's /api/destinations.
//
// Run interactively:
//   node generate-destinations.js
//
// With flags:
//   node generate-destinations.js --type city --count 10 --scope "Japan"
//   node generate-destinations.js --type country -n 5 --no-images
//   node generate-destinations.js --type region -n 6 --scope "Asia" --dry-run

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { select, input, confirm } from '@inquirer/prompts';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('type', { type: 'string', choices: ['country', 'region', 'city'], describe: 'Destination type to generate' })
  .option('count', { alias: 'n', type: 'number', describe: 'How many destinations to generate' })
  .option('scope', { type: 'string', describe: 'Optional geographic scope to guide brainstorming (e.g. "Southeast Asia", "Japan", "Mediterranean")' })
  .option('tone', { type: 'string', default: 'friendly', choices: ['friendly', 'professional', 'adventurous', 'witty', 'luxury'] })
  .option('language', { type: 'string', default: 'English' })
  .option('images', { type: 'boolean', default: true, describe: 'Generate a hero image with Fal.ai (use --no-images to disable)' })
  .option('image-model', { type: 'string', default: 'schnell', choices: ['schnell', 'dev', 'pro'] })
  .option('interactive', { alias: 'i', type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-5-20250929',
  CLAUDE_MAX_TOKENS = '2048',
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
  fatal('FAL_KEY is not set in .env. Use --no-images to skip image generation.');
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const FAL_MODEL_IDS = {
  schnell: 'fal-ai/flux/schnell',
  dev: 'fal-ai/flux/dev',
  pro: 'fal-ai/flux-pro',
};

/* ---------- Claude prompts ---------- */

function systemPromptBrainstorm(type) {
  const guidance = {
    country: 'real-world countries. Prefer a mix of popular and under-the-radar picks.',
    region: 'real-world travel regions — geographical areas larger than a single city but not a whole country (e.g. "Andalusia", "Kansai", "Bavaria", "Tuscany", "Patagonia").',
    city: 'real-world cities travellers actually visit.',
  }[type];
  return `You are a senior travel editor. Brainstorm a list of ${guidance}
Output MUST be strict JSON: { "destinations": [ { "name": string, "countryCode"?: string } ] }
- "name": the canonical English name of the place.
- "countryCode": ISO 3166-1 alpha-2 or alpha-3 (e.g. "JP", "MX", "ES"). Required for type=country and type=city. For type=region, include if the region sits within exactly one country.
Do not include any text outside the JSON. Do not wrap in markdown fences. Produce DISTINCT entries — no near-duplicates, no same place twice.`;
}

function userPromptBrainstorm({ type, count, scope, language }) {
  return [
    `Type: ${type}`,
    `Number to generate: ${count}`,
    scope ? `Scope / focus area: ${scope}` : '',
    `Language for names: ${language} (use the English / canonical travel-guide spelling)`,
    `Return exactly ${count} entries, no fewer, no more.`,
  ].filter(Boolean).join('\n');
}

function systemPromptDestination(type) {
  return `You are a senior travel journalist writing destination guides for a travel blog.
Output MUST be strict JSON matching this TypeScript type:
{
  "name": string,             // canonical English name
  "slug": string,             // kebab-case ASCII, <60 chars
  "type": "country" | "region" | "city",
  "countryCode"?: string,     // ISO 3166-1 alpha-2 (e.g. "JP", "MX"). Required for country/city. Include for region if region sits within exactly one country.
  "description": string,      // 220-290 CHARACTERS (NOT words), hard max 300. One tight, vivid paragraph that hooks the reader: what makes the place special + one sensory detail. Plain prose, no markdown, no headings, no lists.
  "imagePrompt": string       // 30-60 words photographic prompt for a hero/landing image. 16:9 landscape, photorealistic, iconic viewpoint of the destination, specific lighting and time of day, camera lens hint. No logos, no brand names, no copyrighted characters, no close-up faces.
}
Target type is "${type}". Do not include any text outside the JSON. Do not wrap in markdown fences.`;
}

function userPromptDestination({ name, type, countryCode, tone, language, scope }) {
  return [
    `Destination: ${name}`,
    `Type: ${type}`,
    countryCode ? `Country code hint: ${countryCode}` : '',
    scope ? `Scope context: ${scope}` : '',
    `Tone: ${tone}`,
    `Language: ${language}`,
    `Year context: 2026.`,
  ].filter(Boolean).join('\n');
}

/* ---------- Claude calls ---------- */

async function brainstormDestinations({ type, count, scope, language }) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPromptBrainstorm(type),
    messages: [{ role: 'user', content: userPromptBrainstorm({ type, count, scope, language }) }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  if (!json || !Array.isArray(json.destinations)) {
    throw new Error(`Claude did not return a destinations array:\n${text.slice(0, 400)}`);
  }
  const seen = new Set();
  const list = json.destinations
    .map((d) => ({ name: String(d?.name || '').trim(), countryCode: d?.countryCode ? String(d.countryCode).trim().toUpperCase().slice(0, 3) : null }))
    .filter((d) => {
      const key = d.name.toLowerCase();
      if (!d.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count);
  if (!list.length) throw new Error('Claude returned zero usable destinations.');
  return list;
}

async function generateDestination({ name, type, countryCode, tone, language, scope }) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: parseInt(CLAUDE_MAX_TOKENS, 10),
    system: systemPromptDestination(type),
    messages: [{ role: 'user', content: userPromptDestination({ name, type, countryCode, tone, language, scope }) }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  if (!json) throw new Error(`Claude returned non-JSON:\n${text.slice(0, 400)}`);
  if (!json.name) json.name = name;
  if (!json.slug) json.slug = slugify(json.name, { lower: true, strict: true }).slice(0, 60);
  if (!json.type) json.type = type;
  if (!json.countryCode && countryCode) json.countryCode = countryCode;
  if (typeof json.description === 'string' && json.description.length > 300) {
    const cut = json.description.slice(0, 297);
    const lastSpace = cut.lastIndexOf(' ');
    json.description = (lastSpace > 240 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }
  return json;
}

/* ---------- Fal.ai ---------- */

async function generateHeroImage(prompt) {
  const modelId = FAL_MODEL_IDS[argv['image-model']] || FAL_MODEL_IDS.schnell;
  const result = await fal.subscribe(modelId, {
    input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true },
    logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error(`Fal.ai returned no image URL for prompt: ${prompt.slice(0, 80)}…`);
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
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => '');
    throw new Error(`Strapi upload ${uploadRes.status}: ${body.slice(0, 300)}`);
  }
  const uploaded = await uploadRes.json();
  const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (!first?.id) throw new Error('Strapi upload returned no id');
  return first.id;
}

/* ---------- Strapi ---------- */

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strapi ${res.status} on ${pathname}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function findExistingBySlug(slug) {
  const r = await strapi(`/api/destinations?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`);
  return r?.data?.[0] || null;
}

async function postToStrapi(draft, { heroImageId }) {
  const data = {
    name: draft.name,
    slug: draft.slug,
    type: draft.type,
    description: draft.description,
  };
  if (draft.countryCode) data.countryCode = draft.countryCode;
  if (heroImageId) data.heroImage = heroImageId;
  return strapi('/api/destinations', { method: 'POST', body: JSON.stringify({ data }) });
}

/* ---------- Runner ---------- */

async function runOne({ name, type, countryCode, tone, language, scope }) {
  const label = type.padEnd(8);
  const short = name.slice(0, 60);
  process.stdout.write(`→ [${label}] "${short}" … `);
  const t0 = Date.now();
  const draft = await generateDestination({ name, type, countryCode, tone, language, scope });
  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s · `);

  if (argv['dry-run']) {
    console.log('(dry-run)');
    console.log(JSON.stringify(draft, null, 2));
    return;
  }

  const existing = await findExistingBySlug(draft.slug);
  if (existing) {
    console.log(`skipped (slug "${draft.slug}" already exists, id=${existing.id})`);
    return;
  }

  let heroImageId = null;
  if (argv.images) {
    try {
      const baseName = slugify(draft.name, { lower: true, strict: true }).slice(0, 50);
      process.stdout.write(`image… `);
      const tImg = Date.now();
      const url = await generateHeroImage(draft.imagePrompt);
      heroImageId = await uploadImageToStrapi(url, `${baseName}-hero`);
      process.stdout.write(`${((Date.now() - tImg) / 1000).toFixed(1)}s · `);
    } catch (e) {
      console.log(`\n  ⚠ image step failed (${e.message.slice(0, 140)}) — saving destination without image`);
    }
  }

  const created = await postToStrapi(draft, { heroImageId });
  const id = created?.data?.id ?? '?';
  console.log(`created id=${id}${heroImageId ? ` · hero=${heroImageId}` : ''}`);
}

/* ---------- Interactive prompt ---------- */

async function runInteractive() {
  console.log('\nFXN AI Writer — Destinations (interactive)\n');

  const type = await select({
    message: 'What type of destination?',
    default: argv.type || 'city',
    choices: [
      { name: 'City',    value: 'city' },
      { name: 'Country', value: 'country' },
      { name: 'Region',  value: 'region' },
    ],
  });

  const countStr = await input({
    message: 'How many should I generate?',
    default: String(argv.count || 5),
    validate: (v) => {
      const n = Number(v);
      return (Number.isInteger(n) && n > 0 && n <= 50) || 'Enter a whole number between 1 and 50';
    },
  });
  const count = Number(countStr);

  const scope = await input({
    message: 'Optional scope (e.g. "Southeast Asia", "Japan", "Mediterranean") — leave blank for global:',
    default: argv.scope || '',
  });

  const tone = await select({
    message: 'Tone for the descriptions?',
    default: argv.tone || 'friendly',
    choices: [
      { name: 'Friendly',      value: 'friendly' },
      { name: 'Professional',  value: 'professional' },
      { name: 'Adventurous',   value: 'adventurous' },
      { name: 'Witty',         value: 'witty' },
      { name: 'Luxury',        value: 'luxury' },
    ],
  });

  const language = await input({
    message: 'Language?',
    default: argv.language || 'English',
  });

  const images = await confirm({
    message: 'Generate hero images with Fal.ai?',
    default: argv.images !== false,
  });

  const imageModel = images
    ? await select({
        message: 'Fal.ai FLUX variant?',
        default: argv['image-model'] || 'schnell',
        choices: [
          { name: 'schnell (fastest, cheapest)', value: 'schnell' },
          { name: 'dev (balanced)',              value: 'dev' },
          { name: 'pro (best quality, slower)',  value: 'pro' },
        ],
      })
    : argv['image-model'];

  // Apply choices to argv so downstream code picks them up
  argv.type = type;
  argv.count = count;
  argv.scope = scope || undefined;
  argv.tone = tone;
  argv.language = language;
  argv.images = images;
  argv['image-model'] = imageModel;

  await runBatch();
}

async function runBatch() {
  const { type, count, scope, tone, language } = argv;
  if (!type) fatal('--type is required (country | region | city)');
  if (!count) fatal('--count is required');

  console.log(`\nBrainstorming ${count} ${type}${count === 1 ? '' : 's'}${scope ? ` in scope "${scope}"` : ''} with ${CLAUDE_MODEL}…`);
  const list = await brainstormDestinations({ type, count, scope, language });
  console.log(`\nGot ${list.length} ${type}${list.length === 1 ? '' : 's'}:`);
  list.forEach((d, i) => console.log(`  ${String(i + 1).padStart(2)}. ${d.name}${d.countryCode ? ` (${d.countryCode})` : ''}`));
  console.log('');

  let ok = 0, fail = 0, skip = 0;
  for (const d of list) {
    try {
      await runOne({ name: d.name, type, countryCode: d.countryCode, tone, language, scope });
      ok++;
    } catch (e) {
      console.error(`  ✖ ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone — ${ok} created, ${skip} skipped, ${fail} failed.`);
}

/* ---------- Helpers ---------- */

function safeParse(s) {
  try { return JSON.parse(s); }
  catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}
function fatal(msg) { console.error('✖', msg); process.exit(1); }

/* ---------- Entry ---------- */

async function main() {
  const hasAllFlags = argv.type && argv.count;
  if (argv.interactive || !hasAllFlags) return runInteractive();
  return runBatch();
}

main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
