#!/usr/bin/env node
/**
 * generate-gatsby-post.js — AI post generator for the Gatsby (FlexiBlog) sites.
 *
 * Multi-site aware: content is written to the shared `gatsby-post` collection
 * and tagged with a `sites` relation so each Gatsby build pulls only its own
 * posts (site 1 = nxtsmarthome.com.au, site 2 = indepthdaily.com, or both).
 *
 * Interactive (no args):
 *   node generate-gatsby-post.js
 *   → prompts: which site · category (pick/create/none) · topic · length ·
 *     post type · keywords · tone · generate featured images? · publish?
 *
 * Scripted:
 *   node generate-gatsby-post.js --site indepthdaily --category comparisons \
 *     --topic "Best Matter smart plugs in 2026" --length medium --images --publish
 *
 * Model on: generate-originfacts-post.js. Env from ./.env (STRAPI_URL,
 * STRAPI_API_TOKEN, AI_PROVIDER + key, FAL_KEY).
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { select, input, confirm } from '@inquirer/prompts';

const argv = yargs(hideBin(process.argv))
  .option('site', { type: 'string', describe: 'Gatsby site key (e.g. nxtsmarthome, indepthdaily)' })
  .option('category', { type: 'string', describe: 'Category slug (created if missing)' })
  .option('topic', { type: 'string', describe: 'Article topic / working title' })
  .option('length', { alias: 'l', type: 'string', default: 'medium', choices: ['short', 'medium', 'long'] })
  .option('post-type', { type: 'string', default: 'article', choices: ['article', 'guide', 'review', 'roundup', 'news', 'other'] })
  .option('keywords', { type: 'string', describe: 'Comma-separated keywords to weave in' })
  .option('tone', { type: 'string', default: 'professional' })
  .option('images', { type: 'boolean', default: true, describe: 'Generate a featured (cover) image + gallery with Fal.ai FLUX' })
  .option('image-model', { type: 'string', default: 'schnell', choices: ['schnell', 'dev', 'pro'] })
  .option('publish', { type: 'boolean', default: false, describe: 'Publish immediately (default: save as draft)' })
  .option('interactive', { alias: 'i', type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Generate + print, do not write to Strapi' })
  .help()
  .parseSync();

const {
  AI_PROVIDER = 'anthropic',
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  CLAUDE_MAX_TOKENS = '16000',
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6',
  OPENROUTER_MAX_TOKENS = '16000',
  OPENROUTER_SITE_URL = 'https://cms.fxnstudio.com',
  OPENROUTER_APP_NAME = 'FXN Gatsby Writer',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o',
  OPENAI_MAX_OUTPUT_TOKENS = '16000',
  STRAPI_URL = 'http://127.0.0.1:8888',
  STRAPI_API_TOKEN,
  FAL_KEY,
} = process.env;

const aiProvider = (AI_PROVIDER || 'anthropic').toLowerCase();

function fatal(msg) { console.error('✖', msg); process.exit(1); }

if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
if (aiProvider === 'anthropic' && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set.');
if (aiProvider === 'openrouter' && !OPENROUTER_API_KEY) fatal('OPENROUTER_API_KEY is not set.');
if (aiProvider === 'openai' && !OPENAI_API_KEY) fatal('OPENAI_API_KEY is not set.');
if (argv.images && !FAL_KEY) fatal('FAL_KEY is not set — pass --no-images to skip image generation.');

const anthropicClient = aiProvider === 'anthropic' ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const openrouterClient = aiProvider === 'openrouter'
  ? new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' }) : null;
const openaiClient = aiProvider === 'openai' ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const FAL_MODEL_IDS = { schnell: 'fal-ai/flux/schnell', dev: 'fal-ai/flux/dev', pro: 'fal-ai/flux-pro' };

/** Per-site editorial niche used to steer the AI. Falls back to the site name. */
const SITE_NICHE = {
  nxtsmarthome: 'smart home technology — connected devices, home automation, reviews, comparisons and practical how-to guides for everyday homeowners',
};

/* ---------- Strapi ---------- */
async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRAPI_API_TOKEN}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strapi ${res.status} on ${pathname}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Strapi v5 responses may be flat or wrapped in `attributes` — read both.
const attr = (row, key) => row?.[key] ?? row?.attributes?.[key];

async function loadSites() {
  const j = await strapi('/api/gatsby-sites?pagination[pageSize]=100&sort[0]=name:asc');
  return (j.data || []).map((d) => ({ id: d.id, key: attr(d, 'key'), name: attr(d, 'name') }));
}

async function loadCategories(siteId) {
  const filter = siteId ? `&filters[sites][id][$eq]=${siteId}` : '';
  const j = await strapi(`/api/gatsby-categories?pagination[pageSize]=200&sort[0]=name:asc${filter}`);
  return (j.data || []).map((d) => ({ id: d.id, name: attr(d, 'name'), slug: attr(d, 'slug') }));
}

// Find or create a category and ensure it is linked to the given site.
async function resolveOrCreateCategory(slugOrName, siteId) {
  if (!slugOrName) return null;
  const key = slugify(slugOrName, { lower: true, strict: true });
  const found = await strapi(`/api/gatsby-categories?filters[slug][$eq]=${encodeURIComponent(key)}&pagination[pageSize]=1`);
  if (found.data?.length) {
    const cat = found.data[0];
    if (siteId && cat.documentId) {
      // connect is idempotent — safe to re-run for an already-linked category
      try { await strapi(`/api/gatsby-categories/${cat.documentId}`, { method: 'PUT', body: JSON.stringify({ data: { sites: { connect: [siteId] } } }) }); } catch { /* non-fatal */ }
    }
    return cat.id;
  }
  const name = slugOrName.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const data = { name, slug: key };
  if (siteId) data.sites = [siteId];
  const created = await strapi('/api/gatsby-categories', { method: 'POST', body: JSON.stringify({ data }) });
  console.log(`  + created category "${name}"${siteId ? ' (linked to site)' : ''}`);
  return created.data.id;
}

async function resolveOrCreateTags(names = []) {
  const ids = [];
  for (const raw of names.slice(0, 8)) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    const slug = slugify(name, { lower: true, strict: true });
    try {
      const found = await strapi(`/api/gatsby-tags?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`);
      if (found.data?.length) { ids.push(found.data[0].id); continue; }
      const created = await strapi('/api/gatsby-tags', { method: 'POST', body: JSON.stringify({ data: { name, slug } }) });
      ids.push(created.data.id);
    } catch (e) { /* tags are best-effort */ }
  }
  return ids;
}

/* ---------- AI ---------- */
function systemPromptArticle(lengthLabel, niche) {
  return `You are a senior journalist and subject-matter expert writing for a website about: ${niche}.

# Output format
Output MUST be strict JSON matching this TypeScript type:
{
  "title": string,          // 50-70 chars, SEO-optimised
  "slug": string,           // kebab-case ASCII, <60 chars
  "excerpt": string,        // 140-180 chars, plain text, hook the reader
  "content": string,        // Markdown body, ${lengthLabel} words, with H2/H3 headings, bullet lists, and a concrete closing takeaway
  "seoTitle": string,       // <= 65 chars
  "seoDescription": string, // <= 158 chars
  "seoKeywords": string,    // comma-separated, 5-10 terms
  "tags": string[],         // 4-8 lowercase tags
  "readingTimeMinutes": number,
  "imagePrompts": {
    "cover": string,        // Photographic prompt for the HERO image. 16:9 landscape, photorealistic, specific subject, lighting, camera lens hint. No close-up faces, no logos, no brand names. 30-60 words.
    "gallery": string[]     // EXACTLY 2 supporting photographic prompts, different subjects/angles. Same rules. Each 30-60 words.
  }
}
Do not include any text outside the JSON. Do not wrap it in markdown fences.

# Voice
Write like Wirecutter or a sharp expert blog — not a brochure.
- Opinions stated plainly; say what's worth it and what isn't.
- Concrete over abstract. Evidence over vibes. One vivid specific beats three adjectives.
- Contractions OK. First-person where it helps.

# Banned phrases (never use — AI tells / clichés)
nestled · hidden gem · bustling · picture-perfect · must-see · must-have · world-class · game-changer · cutting-edge · seamless · robust · elevate · unlock · leverage · in today's fast-paced world · when it comes to · look no further · rest assured · dive in · delve · tapestry · testament · realm · plethora · myriad · truly · simply

# Banned opening/closing patterns
- Openers: "Picture this…" / "Imagine…" / "In a world where…" / "When it comes to…" / "Have you ever wondered…"
- Closers: "In conclusion…" / "To sum up…" / "At the end of the day…" / generic "so there you have it".

# Concreteness rules
Every H2 section must include AT LEAST ONE of: an exact price/spec/number, a named product/brand/model, a specific date or version, or a measured result. Prefer specific nouns to generic ones.

# Structure
- Lead with a 1-2 sentence hook that makes one concrete promise.
- Scannable, search-friendly H2s; H3s for sub-points.
- Bullet lists for anything comparative, numeric, or sequential (at least 1-2 sections).
- One honest caveat or tradeoff per 400-500 words.
- End with a concrete, actionable next step — not a wrap-up paragraph.

# Facts
Ground everything in real, verifiable facts — named products, real specs, concrete figures. Do not fabricate specifics; generalise when exact numbers aren't reliably known.`;
}

function userPromptArticle(p) {
  const words = ({ short: '400-600', medium: '800-1200', long: '1500-2200' })[p.length];
  return [
    p.title ? `Title (use this EXACT title verbatim, do not rewrite it): ${p.title}` : '',
    `Topic / angle: ${p.topic}`,
    p.category ? `Category: ${p.category}` : '',
    p.postType ? `Article type: ${p.postType}` : '',
    p.tone ? `Tone: ${p.tone}` : '',
    p.keywords ? `Keywords to weave in: ${p.keywords}` : '',
    `Target length: ${words} words`,
  ].filter(Boolean).join('\n');
}

/* ---------- title brainstorming (from keywords + category) ---------- */
function systemPromptTitles(niche) {
  return `You are a senior editor for a website about: ${niche}.
Produce fresh, SEO-optimised, clickable article title ideas.
Output MUST be strict JSON: { "titles": string[] }.
Each title 45-70 chars, specific and actionable (numbers, years, concrete nouns allowed).
Titles must be DISTINCT from each other — no near-duplicates. Avoid clickbait and AI clichés
(no "ultimate guide", "unlock", "game-changer", "you won't believe").
No text outside the JSON. No markdown fences.`;
}
function userPromptTitles({ category, keywords, tone, count }) {
  return [
    category ? `Category: ${category}` : '',
    keywords ? `Keywords / angle to build titles around: ${keywords}` : '',
    tone ? `Tone: ${tone}` : '',
    `Year context: 2026.`,
    `Return exactly ${count} distinct titles.`,
  ].filter(Boolean).join('\n');
}
async function generateTitles({ niche, category, keywords, tone, count = 6 }) {
  const text = await callAI({ system: systemPromptTitles(niche), user: userPromptTitles({ category, keywords, tone, count }), maxTokens: 1024 });
  const json = safeParse(text);
  if (!json || !Array.isArray(json.titles)) throw new Error(`${providerName()} did not return titles:\n${text.slice(0, 300)}`);
  const seen = new Set();
  const titles = json.titles.map((t) => String(t).trim()).filter((t) => { const k = t.toLowerCase(); if (!t || seen.has(k)) return false; seen.add(k); return true; }).slice(0, count);
  if (!titles.length) throw new Error(`${providerName()} returned zero usable titles.`);
  return titles;
}
// Interactive: brainstorm titles from keywords/category, let the user pick / regenerate / write own.
async function pickTitle({ niche, category, keywords, tone }) {
  for (;;) {
    process.stdout.write('  brainstorming titles… ');
    const titles = await generateTitles({ niche, category, keywords, tone, count: 6 });
    process.stdout.write('done\n');
    const choice = await select({
      message: 'Pick a title:',
      pageSize: 10,
      choices: [
        ...titles.map((t) => ({ name: t, value: t })),
        { name: '↻ Regenerate options', value: '__regen__' },
        { name: '✎ Write my own', value: '__own__' },
      ],
    });
    if (choice === '__regen__') continue;
    if (choice === '__own__') return (await input({ message: 'Title:', validate: (v) => v.trim().length > 0 || 'Enter a title' })).trim();
    return choice;
  }
}

async function callAI({ system, user, maxTokens }) {
  if (aiProvider === 'openai') {
    const r = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
    });
    return r.choices?.[0]?.message?.content?.trim() || '';
  }
  if (aiProvider === 'openrouter') {
    const r = await openrouterClient.chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      extra_headers: { 'HTTP-Referer': OPENROUTER_SITE_URL, 'X-OpenRouter-Title': OPENROUTER_APP_NAME },
    });
    return r.choices?.[0]?.message?.content?.trim() || '';
  }
  const msg = await anthropicClient.messages.create({
    model: CLAUDE_MODEL, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: user }],
  });
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

function providerName() { return aiProvider === 'openrouter' ? 'OpenRouter' : aiProvider === 'openai' ? 'OpenAI' : 'Claude'; }
function maxTokensEnv() {
  const v = aiProvider === 'openrouter' ? OPENROUTER_MAX_TOKENS : aiProvider === 'openai' ? OPENAI_MAX_OUTPUT_TOKENS : CLAUDE_MAX_TOKENS;
  return Math.max(parseInt(v, 10) || 0, 16000);
}

function safeParse(s) {
  try { return JSON.parse(s); }
  catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

async function generateArticle(p) {
  const lengthLabel = ({ short: '400-600', medium: '800-1200', long: '1500-2200' })[p.length];
  const text = await callAI({ system: systemPromptArticle(lengthLabel, p.niche), user: userPromptArticle(p), maxTokens: maxTokensEnv() });
  const json = safeParse(text);
  if (!json) throw new Error(`${providerName()} returned non-JSON:\n${text.slice(0, 400)}`);
  if (p.title) json.title = p.title; // enforce the chosen/brainstormed title
  if (!json.slug) json.slug = slugify(json.title || p.topic, { lower: true, strict: true }).slice(0, 60);
  const truncate = (s, max) => (s && s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);
  json.title = truncate(json.title, 255);
  json.seoTitle = truncate(json.seoTitle, 68);
  json.seoDescription = truncate(json.seoDescription, 158);
  json.excerpt = truncate(json.excerpt, 480);
  json.slug = String(json.slug).slice(0, 60);
  if (!Number.isInteger(json.readingTimeMinutes) || json.readingTimeMinutes < 1) json.readingTimeMinutes = 5;
  return json;
}

/* ---------- Fal.ai images ---------- */
async function generateImage(prompt, { aspect = 'landscape_16_9' } = {}) {
  const modelId = FAL_MODEL_IDS[argv['image-model']] || FAL_MODEL_IDS.schnell;
  const result = await fal.subscribe(modelId, {
    input: { prompt, image_size: aspect, num_images: 1, enable_safety_checker: true }, logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error(`Fal.ai returned no image for: ${prompt.slice(0, 60)}…`);
  return url;
}

async function uploadImageToStrapi(imageUrl, filename) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Download failed ${imageUrl}: ${res.status}`);
  const ab = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('files', new Blob([ab], { type: contentType }), `${filename}.${ext}`.slice(0, 120));
  const up = await fetch(`${STRAPI_URL}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` }, body: form });
  if (!up.ok) throw new Error(`Strapi upload ${up.status}: ${(await up.text().catch(() => '')).slice(0, 200)}`);
  const uploaded = await up.json();
  const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  if (!first?.id) throw new Error('Strapi upload returned no id');
  return first.id;
}

async function generateAndUploadImages(draft) {
  const prompts = draft?.imagePrompts;
  if (!prompts?.cover) { console.log(`  (no image prompts from ${providerName()} — skipping images)`); return { coverId: null, galleryIds: [] }; }
  const base = slugify(draft.title || 'post', { lower: true, strict: true }).slice(0, 50);
  const jobs = [
    { kind: 'cover', prompt: prompts.cover, aspect: 'landscape_16_9' },
    ...(Array.isArray(prompts.gallery) ? prompts.gallery.slice(0, 2) : []).map((p, i) => ({ kind: `gallery-${i + 1}`, prompt: p, aspect: 'landscape_4_3' })),
  ];
  process.stdout.write(`  generating ${jobs.length} image(s) with FLUX [${argv['image-model']}]… `);
  const t0 = Date.now();
  const results = await Promise.all(jobs.map(async ({ kind, prompt, aspect }) => ({ kind, id: await uploadImageToStrapi(await generateImage(prompt, { aspect }), `${base}-${kind}`) })));
  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  return { coverId: results.find((r) => r.kind === 'cover')?.id ?? null, galleryIds: results.filter((r) => r.kind !== 'cover').map((r) => r.id) };
}

/* ---------- create ---------- */
async function createGatsbyPost(draft, opts) {
  const data = {
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt,
    content: draft.content,
    postType: opts.postType || 'article',
    readingTimeMinutes: draft.readingTimeMinutes,
    seoTitle: draft.seoTitle,
    seoDescription: draft.seoDescription,
    seoKeywords: draft.seoKeywords,
    source: 'ai',
    sites: [opts.siteId],
  };
  if (opts.categoryId) data.categories = [opts.categoryId];
  if (opts.tagIds?.length) data.tags = opts.tagIds;
  if (opts.coverId) data.coverImage = opts.coverId;
  if (opts.galleryIds?.length) data.gallery = opts.galleryIds;
  if (opts.publish) data.publishedAt = new Date().toISOString();
  return strapi('/api/gatsby-posts', { method: 'POST', body: JSON.stringify({ data }) });
}

/* ---------- run one ---------- */
async function runOne(p) {
  console.log(`\n▸ [${p.siteKey}] "${p.topic}" (${p.length}, ${p.postType})`);
  const draft = await generateArticle(p);
  console.log(`  ✓ ${providerName()} wrote "${draft.title}" (${(draft.content || '').split(/\s+/).length} words)`);

  let coverId = null, galleryIds = [];
  if (p.images) {
    try { ({ coverId, galleryIds } = await generateAndUploadImages(draft)); }
    catch (e) { console.log(`  ! image step failed: ${e.message}`); }
  }

  const tagIds = await resolveOrCreateTags(draft.tags);

  if (p.dryRun) {
    console.log('  [dry-run] would create gatsby-post:', JSON.stringify({ title: draft.title, slug: draft.slug, site: p.siteKey, category: p.categorySlug || null, coverId, tags: draft.tags }, null, 2));
    return;
  }

  const created = await createGatsbyPost(draft, {
    siteId: p.siteId, categoryId: p.categoryId, tagIds, coverId, galleryIds, postType: p.postType, publish: p.publish,
  });
  const id = created?.data?.id;
  console.log(`  ✓ ${p.publish ? 'published' : 'saved draft'} gatsby-post #${id} — /${draft.slug}`);
}

/* ---------- interactive ---------- */
async function runInteractive() {
  console.log('\nFXN Gatsby Writer — interactive\n');
  const sites = await loadSites();
  if (!sites.length) fatal('No Gatsby sites found in Strapi (create entries in "Gatsby · Site").');

  const siteId = await select({ message: 'Which Gatsby site?', choices: sites.map((s) => ({ name: `${s.name} (${s.key})`, value: s.id })) });
  const site = sites.find((s) => s.id === siteId);

  const cats = await loadCategories(siteId);
  const categoryChoice = await select({
    message: 'Category?',
    choices: [
      ...cats.map((c) => ({ name: c.name, value: `slug:${c.slug}` })),
      { name: '＋ Create a new category', value: '__new__' },
      { name: '(none)', value: '__none__' },
    ],
  });
  let categorySlug = null;
  if (categoryChoice === '__new__') categorySlug = (await input({ message: 'New category name:', validate: (v) => v.trim().length > 0 || 'Enter a name' })).trim();
  else if (categoryChoice.startsWith('slug:')) categorySlug = categoryChoice.slice(5);

  // Keywords drive the article — the title is brainstormed from them + the category.
  const keywords = (await input({
    message: 'Keywords the article should be about (comma-separated):',
    validate: (v) => v.trim().length > 0 || categorySlug ? true : 'Enter at least one keyword (or pick a category)',
  })).trim() || null;
  const tone = await select({ message: 'Tone?', default: 'professional', choices: ['professional', 'friendly', 'authoritative', 'conversational', 'witty'].map((v) => ({ name: v, value: v })) });

  const niche = SITE_NICHE[site.key] || site.name;
  const title = await pickTitle({ niche, category: categorySlug, keywords, tone });

  const length = await select({ message: 'Article length?', default: 'medium', choices: [
    { name: 'Short (~500 words)', value: 'short' }, { name: 'Medium (~1000 words)', value: 'medium' }, { name: 'Long (~1800 words)', value: 'long' } ] });
  const postType = await select({ message: 'Post type?', default: 'article', choices: ['article', 'guide', 'review', 'roundup', 'news', 'other'].map((v) => ({ name: v, value: v })) });
  const images = FAL_KEY ? await confirm({ message: 'Generate a featured image (+ gallery) with Fal.ai FLUX?', default: true }) : false;
  const publish = await confirm({ message: 'Publish immediately? (No = save as draft)', default: false });

  const categoryId = categorySlug ? await resolveOrCreateCategory(categorySlug, siteId) : null;
  await runOne({
    siteId, siteKey: site.key, niche,
    categoryId, categorySlug, title, topic: title, length, postType, keywords, tone,
    images, publish, dryRun: argv['dry-run'],
  });
}

/* ---------- entry ---------- */
async function main() {
  // Scripted path: --site plus at least one of --keywords / --category / --topic.
  if (argv.site && (argv.keywords || argv.category || argv.topic)) {
    const sites = await loadSites();
    const site = sites.find((s) => s.key === argv.site || String(s.id) === String(argv.site));
    if (!site) fatal(`Site "${argv.site}" not found. Available: ${sites.map((s) => s.key).join(', ')}`);
    const niche = SITE_NICHE[site.key] || site.name;
    // Title: explicit --topic wins; otherwise brainstorm one from keywords/category.
    let title = argv.topic;
    if (!title) {
      const [t] = await generateTitles({ niche, category: argv.category, keywords: argv.keywords, tone: argv.tone, count: 1 });
      title = t;
      console.log(`  auto-title: ${title}`);
    }
    const categoryId = argv.category ? await resolveOrCreateCategory(argv.category, site.id) : null;
    return runOne({
      siteId: site.id, siteKey: site.key, niche,
      categoryId, categorySlug: argv.category || null, title, topic: title,
      length: argv.length, postType: argv['post-type'], keywords: argv.keywords || null,
      tone: argv.tone, images: argv.images, publish: argv.publish, dryRun: argv['dry-run'],
    });
  }
  if (argv.interactive || process.stdin.isTTY) return runInteractive();
  fatal('No inputs. Run interactively, or pass --site <key> with --keywords "…" (and optionally --category). See --help.');
}

main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
