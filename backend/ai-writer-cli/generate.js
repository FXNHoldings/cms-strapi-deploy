#!/usr/bin/env node
// FXN AI Writer CLI
// Generates travel articles with Claude Sonnet 4.5 and posts them as drafts (or published) to Strapi,
// optionally assigning each article to the right category.
//
// Three ways to use it:
//   1) Fully automatic — pick a category + count, Claude invents the titles AND writes them:
//        node generate.js --category flights --count 5
//        node generate.js -c hotels -n 10 --publish
//
//   2) Interactive (no args) — prompts you for category + count:
//        node generate.js
//
//   3) Manual topic(s) — you supply the title(s) yourself:
//        node generate.js "Cheap flights London to Bangkok" --category flights
//        node generate.js --topics topics.txt
//        node generate.js --auto-fill            (6 categories × 6 preset topics)

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fal } from '@fal-ai/client';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { select, input, confirm } from '@inquirer/prompts';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [topic] [options]')
  .option('topic', { alias: 't', type: 'string' })
  .option('topics', { type: 'string', describe: 'File with "category | topic" per line' })
  .option('auto-fill', { type: 'boolean', default: false, describe: 'Auto-generate across the 6 preset categories' })
  .option('count', { alias: 'n', type: 'number', describe: 'How many articles to generate (Claude will brainstorm the titles)' })
  .option('tone', { type: 'string', default: 'friendly', choices: ['friendly', 'professional', 'adventurous', 'witty', 'luxury'] })
  .option('length', { alias: 'l', type: 'string', default: 'medium', choices: ['short', 'medium', 'long'] })
  .option('destination', { alias: 'd', type: 'string' })
  .option('category', { alias: 'c', type: 'string', describe: 'Category slug or name (e.g. flights, hotels, travel-tips)' })
  .option('keywords', { alias: 'k', type: 'string' })
  .option('language', { type: 'string', default: 'English' })
  .option('publish', { type: 'boolean', default: false, describe: 'Publish immediately (default: save as draft)' })
  .option('interactive', { alias: 'i', type: 'boolean', default: false, describe: 'Force interactive prompt even if flags are set' })
  .option('images', { type: 'boolean', default: true, describe: 'Generate 1 cover + 2 gallery images with Fal.ai (use --no-images to disable)' })
  .option('image-model', { type: 'string', default: 'schnell', choices: ['schnell', 'dev', 'pro'], describe: 'Fal.ai FLUX variant' })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const positionalTopic = argv._[0];
if (!argv.topic && positionalTopic) argv.topic = String(positionalTopic);

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-5-20250929',
  CLAUDE_MAX_TOKENS = '4096',
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
  fatal('FAL_KEY is not set in .env. Get one at https://fal.ai/dashboard/keys — or pass --no-images to skip image generation.');
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const FAL_MODEL_IDS = {
  schnell: 'fal-ai/flux/schnell',
  dev: 'fal-ai/flux/dev',
  pro: 'fal-ai/flux-pro',
};

/** The 6 main site categories — used for the interactive picker and as fallbacks. */
const CATEGORY_CHOICES = [
  { name: 'Destinations',      value: 'destinations' },
  { name: 'Flights',           value: 'flights' },
  { name: 'Hotels',            value: 'hotels' },
  { name: 'Travel Resources',  value: 'travel-resources' },
  { name: 'Travel Tips',       value: 'travel-tips' },
  { name: 'Car Rental',        value: 'car-rental' },
];

/** In-memory cache so we only hit /api/categories once per run */
const categoryCache = new Map();

async function resolveCategoryId(slugOrName) {
  if (!slugOrName) return null;
  const key = String(slugOrName).trim().toLowerCase();
  if (categoryCache.has(key)) return categoryCache.get(key);

  // Try slug first, then name
  const bySlug = await strapi(
    `/api/categories?filters[slug][$eq]=${encodeURIComponent(key)}&pagination[pageSize]=1`,
  );
  let cat = bySlug?.data?.[0];
  if (!cat) {
    const byName = await strapi(
      `/api/categories?filters[name][$eqi]=${encodeURIComponent(slugOrName)}&pagination[pageSize]=1`,
    );
    cat = byName?.data?.[0];
  }
  if (!cat) {
    // Auto-create if missing
    console.log(`  · Category "${slugOrName}" not found in Strapi — creating it`);
    const created = await strapi('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ data: { name: capitalize(slugOrName), slug: slugifyCategory(slugOrName) } }),
    });
    cat = created.data;
  }
  categoryCache.set(key, cat.id);
  return cat.id;
}

function slugifyCategory(s) {
  return slugify(String(s), { lower: true, strict: true }).slice(0, 60);
}
function capitalize(s) {
  return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

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

/* ---------- Claude prompts ---------- */

function systemPromptArticle(lengthLabel) {
  return `You are a senior travel journalist writing for a travel blog (flights, hotels, destinations, tips).
Output MUST be strict JSON matching this TypeScript type:
{
  "title": string,          // 50-70 chars, SEO-optimised
  "slug": string,           // kebab-case ASCII, <60 chars
  "excerpt": string,        // 140-180 chars, plain text, hook the reader
  "content": string,        // Markdown body, ${lengthLabel} words, with H2/H3 headings, bullet lists, and a strong closing CTA
  "seoTitle": string,       // <= 65 chars
  "seoDescription": string, // <= 158 chars
  "seoKeywords": string,    // comma-separated, 5-10 terms
  "tags": string[],         // 4-8 lowercase tags
  "readingTimeMinutes": number,
  "imagePrompts": {
    "cover": string,        // Detailed photographic prompt for the HERO/featured image. 16:9 landscape. Photorealistic travel photo, specific location/subject, time of day, lighting, camera lens hint. No people's faces unless stock-photo vibe. 30-60 words.
    "gallery": string[]     // EXACTLY 2 additional photographic prompts that visually support different sections of the article. Same style guidance as cover. Each 30-60 words.
  }
}
Do not include any text outside the JSON. Do not wrap it in markdown fences. Use honest, specific, actionable advice. Image prompts must be vivid, concrete, and free of logos, brand names, or copyrighted characters.`;
}

function userPromptArticle(p) {
  const words = ({ short: '400-600', medium: '800-1200', long: '1500-2200' })[p.length];
  return [
    `Topic: ${p.topic}`,
    p.destination ? `Destination: ${p.destination}` : '',
    p.category ? `Category: ${p.category}` : '',
    p.tone ? `Tone: ${p.tone}` : '',
    p.keywords ? `Keywords to weave in: ${p.keywords}` : '',
    p.language ? `Language: ${p.language}` : '',
    `Target length: ${words} words`,
  ].filter(Boolean).join('\n');
}

function systemPromptTitles() {
  return `You are a senior travel editor. You produce fresh, SEO-optimised article title ideas for a travel blog.
Output MUST be strict JSON of the form: { "titles": string[] }.
Each title: 50-70 chars, specific, actionable, and clickable (numbers, years, concrete places allowed).
Titles must be DISTINCT from each other — no near-duplicates, no same angle twice.
Do not include any text outside the JSON. Do not wrap it in markdown fences.`;
}

function userPromptTitles({ category, count, tone, language, keywords, destination }) {
  return [
    `Category: ${category}`,
    `Number of titles: ${count}`,
    `Tone: ${tone}`,
    `Language: ${language}`,
    destination ? `Destination focus: ${destination}` : '',
    keywords ? `Keywords to consider: ${keywords}` : '',
    `Year context: 2026.`,
    `Return exactly ${count} titles, no fewer, no more.`,
  ].filter(Boolean).join('\n');
}

/* ---------- Claude calls ---------- */

async function generateTitles({ category, count, tone, language, keywords, destination }) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPromptTitles(),
    messages: [{
      role: 'user',
      content: userPromptTitles({ category, count, tone, language, keywords, destination }),
    }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  if (!json || !Array.isArray(json.titles)) {
    throw new Error(`Claude did not return a titles array:\n${text.slice(0, 400)}`);
  }
  // De-dupe & trim
  const seen = new Set();
  const titles = json.titles
    .map((t) => String(t).trim())
    .filter((t) => {
      const key = t.toLowerCase();
      if (!t || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count);

  if (!titles.length) throw new Error('Claude returned zero usable titles.');
  return titles;
}

async function generateArticle(p) {
  const lengthLabel = ({ short: '400-600', medium: '800-1200', long: '1500-2200' })[p.length];
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: parseInt(CLAUDE_MAX_TOKENS, 10),
    system: systemPromptArticle(lengthLabel),
    messages: [{ role: 'user', content: userPromptArticle(p) }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  if (!json) throw new Error(`Claude returned non-JSON:\n${text.slice(0, 400)}`);
  if (!json.slug) json.slug = slugify(json.title || p.topic, { lower: true, strict: true }).slice(0, 60);
  return json;
}

/* ---------- Fal.ai images ---------- */

async function generateImage(prompt, { aspect = 'landscape_16_9' } = {}) {
  const modelId = FAL_MODEL_IDS[argv['image-model']] || FAL_MODEL_IDS.schnell;
  const result = await fal.subscribe(modelId, {
    input: {
      prompt,
      image_size: aspect,
      num_images: 1,
      enable_safety_checker: true,
    },
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

async function generateAndUploadImages(draft) {
  const prompts = draft?.imagePrompts;
  if (!prompts?.cover || !Array.isArray(prompts.gallery) || prompts.gallery.length < 1) {
    console.log('  (no image prompts returned by Claude — skipping images)');
    return { coverId: null, galleryIds: [] };
  }

  const baseName = slugify(draft.title || 'article', { lower: true, strict: true }).slice(0, 50);
  process.stdout.write(`  generating ${1 + prompts.gallery.length} images with Fal.ai FLUX [${argv['image-model']}]… `);
  const t0 = Date.now();

  const allPrompts = [
    { kind: 'cover', prompt: prompts.cover, aspect: 'landscape_16_9' },
    ...prompts.gallery.slice(0, 2).map((p, i) => ({ kind: `gallery-${i + 1}`, prompt: p, aspect: 'landscape_4_3' })),
  ];

  // Run in parallel — fal.ai handles concurrency fine for small batches
  const results = await Promise.all(
    allPrompts.map(async ({ kind, prompt, aspect }) => {
      const url = await generateImage(prompt, { aspect });
      const id = await uploadImageToStrapi(url, `${baseName}-${kind}`);
      return { kind, id };
    }),
  );

  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s · `);

  const coverId = results.find((r) => r.kind === 'cover')?.id ?? null;
  const galleryIds = results.filter((r) => r.kind !== 'cover').map((r) => r.id);
  return { coverId, galleryIds };
}

/* ---------- Strapi ---------- */

async function postToStrapi(draft, opts) {
  const data = {
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt,
    content: draft.content,
    seoTitle: draft.seoTitle,
    seoDescription: draft.seoDescription,
    seoKeywords: draft.seoKeywords,
    readingTimeMinutes: draft.readingTimeMinutes,
    source: 'ai',
  };
  if (opts.categoryId) data.category = opts.categoryId;
  if (opts.coverId) data.coverImage = opts.coverId;
  if (opts.galleryIds?.length) data.gallery = opts.galleryIds;
  if (opts.publish) data.publishedAt = new Date().toISOString();

  const res = await strapi('/api/articles', { method: 'POST', body: JSON.stringify({ data }) });
  return res;
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

/** Auto-fill preset — 6 topics across the 6 main home-page sections */
const AUTO_TOPICS = {
  destinations: [
    '7 under-the-radar cities in Portugal for 2026',
    'The complete first-timer guide to Kyoto',
    'A 10-day Vietnam itinerary for under $800',
    'Why Oaxaca is the best food destination in Mexico',
    'Iceland in winter: ring road in 7 days',
    'Seoul neighbourhoods ranked for first-time visitors',
  ],
  flights: [
    '7 proven hacks for cheap London-Bangkok flights in 2026',
    'How to find error fares (and actually book them)',
    'Business class for economy prices: the points guide',
    'The best day and time to book international flights',
    'Why flying on Tuesday saves you up to 40%',
    'Flight comparison sites ranked: Google Flights vs Skyscanner vs Kiwi',
  ],
  hotels: [
    '5 boutique hotels in Kyoto under $150 a night',
    'The 10 best-value all-inclusives in Mexico for 2026',
    'Hostels that don\'t feel like hostels: our 2026 picks',
    'How to get free hotel upgrades (without being annoying)',
    'Why you should book direct instead of Booking.com',
    'The best hotel loyalty programme in 2026, explained',
  ],
  'travel-resources': [
    'The travel insurance we actually buy (and why)',
    '10 essential travel apps we use every trip',
    'How to pack a carry-on for 3 weeks: our exact list',
    'Best travel credit cards for UK residents in 2026',
    'The eSIM providers we trust (and which to avoid)',
    'Travel adapters, power banks, and the gear we swear by',
  ],
  'travel-tips': [
    'How to avoid jet lag on long-haul flights',
    '7 mistakes first-time Europe travellers make',
    'The solo female traveller safety guide',
    'How to eat well on the road without blowing the budget',
    'Language apps ranked: Duolingo vs Pimsleur vs ChatGPT',
    'Why you should always book the first flight of the day',
  ],
  'car-rental': [
    'Car rental in Europe: the complete 2026 guide',
    'How to avoid getting scammed at the rental counter',
    'Automatic vs manual: renting abroad as a UK/US driver',
    'The cheapest countries to rent a car (and the worst)',
    'What travel insurance actually covers for rentals',
    'Road trip routes: 5 drives worth flying for',
  ],
};

/* ---------- Runners ---------- */

async function runOne({ topic, category }) {
  const params = {
    topic,
    tone: argv.tone,
    length: argv.length,
    destination: argv.destination,
    category: category || argv.category,
    keywords: argv.keywords,
    language: argv.language,
  };

  const label = (category || argv.category || 'uncategorised').padEnd(18);
  const short = topic.slice(0, 60) + (topic.length > 60 ? '…' : '');
  process.stdout.write(`→ [${label}] "${short}" … `);
  const t0 = Date.now();
  const draft = await generateArticle(params);
  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s · `);

  if (argv['dry-run']) {
    console.log('(dry-run)');
    console.log(JSON.stringify(draft, null, 2));
    return;
  }

  let coverId = null, galleryIds = [];
  if (argv.images) {
    try {
      ({ coverId, galleryIds } = await generateAndUploadImages(draft));
    } catch (e) {
      console.log(`\n  ⚠ image step failed (${e.message.slice(0, 140)}) — saving article without images`);
    }
  }

  const categoryId = await resolveCategoryId(category || argv.category);
  const created = await postToStrapi(draft, { categoryId, coverId, galleryIds, publish: argv.publish });
  const id = created?.data?.id ?? '?';
  console.log(`${argv.publish ? 'PUBLISHED' : 'draft'} id=${id}${coverId ? ` · cover=${coverId}` : ''}${galleryIds.length ? ` · gallery=[${galleryIds.join(',')}]` : ''}`);
}

async function runCategoryAuto({ category, count }) {
  console.log(`\nBrainstorming ${count} title${count === 1 ? '' : 's'} for "${category}" with ${CLAUDE_MODEL}…`);
  const titles = await generateTitles({
    category,
    count,
    tone: argv.tone,
    language: argv.language,
    keywords: argv.keywords,
    destination: argv.destination,
  });

  console.log(`\nGot ${titles.length} title${titles.length === 1 ? '' : 's'}:`);
  titles.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t}`));
  console.log('');

  let ok = 0, fail = 0;
  for (const topic of titles) {
    try { await runOne({ topic, category }); ok++; }
    catch (e) { console.error(`  ✖ ${e.message}`); fail++; }
  }
  console.log(`\nDone — ${ok} created, ${fail} failed.`);
}

async function runBatch(file) {
  const raw = fs.readFileSync(path.resolve(file), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const jobs = raw.map((line) => {
    // Format: "category | topic"
    const m = line.match(/^([^|]+)\|(.+)$/);
    if (m) return { category: m[1].trim(), topic: m[2].trim() };
    // Fallback: treat whole line as topic, use --category flag
    return { category: null, topic: line };
  });

  console.log(`Batch: ${jobs.length} articles\n`);
  let ok = 0, fail = 0;
  for (const j of jobs) {
    try { await runOne(j); ok++; } catch (e) { console.error(`  ✖ ${e.message}`); fail++; }
  }
  console.log(`\nDone — ${ok} created, ${fail} failed.`);
}

async function runAutoFill() {
  const all = [];
  for (const [slug, topics] of Object.entries(AUTO_TOPICS)) {
    for (const topic of topics) all.push({ category: slug, topic });
  }
  console.log(`Auto-fill: ${all.length} articles (6 categories × 6 topics)\n`);
  let ok = 0, fail = 0;
  for (const j of all) {
    try { await runOne(j); ok++; } catch (e) { console.error(`  ✖ ${e.message}`); fail++; }
  }
  console.log(`\nDone — ${ok} created, ${fail} failed.`);
}

/* ---------- Interactive prompt ---------- */

async function runInteractive() {
  console.log('\nFXN AI Writer — interactive mode\n');

  const category = await select({
    message: 'Which category should the articles go into?',
    choices: [
      ...CATEGORY_CHOICES,
      { name: 'Other (type a custom slug)', value: '__custom__' },
    ],
  });

  let finalCategory = category;
  if (category === '__custom__') {
    finalCategory = await input({
      message: 'Category slug (e.g. city-breaks):',
      validate: (v) => v.trim().length > 0 || 'Please enter a slug',
    });
  }

  const countStr = await input({
    message: 'How many articles should I generate?',
    default: '3',
    validate: (v) => {
      const n = Number(v);
      return (Number.isInteger(n) && n > 0 && n <= 50) || 'Enter a whole number between 1 and 50';
    },
  });
  const count = Number(countStr);

  const length = await select({
    message: 'Length per article?',
    default: argv.length || 'medium',
    choices: [
      { name: 'Short (~500 words)',  value: 'short' },
      { name: 'Medium (~1000 words)', value: 'medium' },
      { name: 'Long (~1800 words)',  value: 'long' },
    ],
  });

  const tone = await select({
    message: 'Tone?',
    default: argv.tone || 'friendly',
    choices: [
      { name: 'Friendly',      value: 'friendly' },
      { name: 'Professional',  value: 'professional' },
      { name: 'Adventurous',   value: 'adventurous' },
      { name: 'Witty',         value: 'witty' },
      { name: 'Luxury',        value: 'luxury' },
    ],
  });

  const publish = await confirm({
    message: 'Publish immediately? (No = save as drafts in Strapi)',
    default: false,
  });

  // Apply choices to argv so runOne/resolveCategoryId pick them up
  argv.category = finalCategory;
  argv.length = length;
  argv.tone = tone;
  argv.publish = publish;

  await runCategoryAuto({ category: finalCategory, count });
}

/* ---------- Entry ---------- */

async function main() {
  if (argv['auto-fill']) return runAutoFill();
  if (argv.topics) return runBatch(argv.topics);

  // New: category + count = auto brainstorm + write
  if (argv.category && argv.count && !argv.topic) {
    return runCategoryAuto({ category: argv.category, count: argv.count });
  }

  // Manual single topic
  if (argv.topic) return runOne({ topic: argv.topic, category: argv.category });

  // No inputs → interactive picker
  if (argv.interactive || process.stdin.isTTY) return runInteractive();

  fatal('No topic provided. Use --category + --count, a "topic" arg, --topics file, or --auto-fill.');
}

main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
