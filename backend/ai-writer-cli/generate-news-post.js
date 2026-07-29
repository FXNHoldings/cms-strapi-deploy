#!/usr/bin/env node
/**
 * generate-news-post.js — source real news (OpenWeb Ninja) and publish original
 * AI-written articles to the Gatsby sites (default: indepthdaily.com).
 *
 * Flow (interactive):
 *   site → category (from Strapi, per site) → fetch news for that category
 *   (topic headlines if it maps, else keyword search) → multi-select headlines
 *   → each is rewritten into an ORIGINAL article (with source attribution),
 *   an image is generated, and a gatsby-post is created tagged to the site +
 *   category.
 *
 * Uses OpenWeb Ninja "Real-Time News Data":
 *   GET /top-headlines?topic=TECHNOLOGY|HEALTH|ENTERTAINMENT|BUSINESS|SCIENCE|SPORTS|WORLD|NATIONAL
 *   GET /search?query=<keywords>
 * Env (./.env): OPENWEBNINJA_API_KEY, STRAPI_URL, STRAPI_API_TOKEN, AI provider, FAL_KEY.
 *
 * Scripted:
 *   node generate-news-post.js --site indepthdaily --category technology --count 5 --pick 2 --publish
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { select, input, confirm, checkbox } from '@inquirer/prompts';
import { extract } from '@extractus/article-extractor';
import { NodeHtmlMarkdown } from 'node-html-markdown';

const argv = yargs(hideBin(process.argv))
  .option('site', { type: 'string', default: 'nxtsmarthome', describe: 'Gatsby site key' })
  .option('category', { type: 'string', describe: 'Category slug to source + publish to' })
  .option('query', { type: 'string', describe: 'Override: keyword news search instead of the category topic' })
  .option('count', { type: 'number', default: 10, describe: 'How many headlines to fetch' })
  .option('pick', { type: 'number', describe: 'Scripted: auto-take the first N headlines' })
  .option('length', { alias: 'l', type: 'string', default: 'medium', choices: ['short', 'medium', 'long'] })
  .option('raw', { type: 'boolean', default: false, describe: 'Import headline + snippet + source image as-is (no AI rewrite)' })
  .option('full', { type: 'boolean', default: false, describe: 'Fetch the full article body from the source URL (extractor)' })
  .option('images', { type: 'boolean', default: true })
  .option('image-model', { type: 'string', default: 'schnell', choices: ['schnell', 'dev', 'pro'] })
  .option('country', { type: 'string', default: 'US' })
  .option('lang', { type: 'string', default: 'en' })
  .option('publish', { type: 'boolean', default: false })
  .option('interactive', { alias: 'i', type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Fetch + generate, do not write to Strapi' })
  .help()
  .parseSync();

const {
  AI_PROVIDER = 'anthropic', ANTHROPIC_API_KEY, CLAUDE_MODEL = 'claude-sonnet-4-6', CLAUDE_MAX_TOKENS = '16000',
  OPENROUTER_API_KEY, OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6', OPENROUTER_MAX_TOKENS = '16000',
  OPENROUTER_SITE_URL = 'https://cms.fxnstudio.com', OPENROUTER_APP_NAME = 'FXN News Writer',
  OPENAI_API_KEY, OPENAI_MODEL = 'gpt-4o', OPENAI_MAX_OUTPUT_TOKENS = '16000',
  STRAPI_URL = 'http://127.0.0.1:8888', STRAPI_API_TOKEN, FAL_KEY,
  OPENWEBNINJA_API_KEY, OPENWEBNINJA_NEWS_BASE = 'https://api.openwebninja.com/realtime-news-data',
} = process.env;

const aiProvider = (AI_PROVIDER || 'anthropic').toLowerCase();
function fatal(m) { console.error('✖', m); process.exit(1); }
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN not set');
if (!OPENWEBNINJA_API_KEY) fatal('OPENWEBNINJA_API_KEY not set (add to .env)');
if (aiProvider === 'anthropic' && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY not set');
if (aiProvider === 'openrouter' && !OPENROUTER_API_KEY) fatal('OPENROUTER_API_KEY not set');
if (aiProvider === 'openai' && !OPENAI_API_KEY) fatal('OPENAI_API_KEY not set');
if (argv.images && !argv.raw && !FAL_KEY) fatal('FAL_KEY not set — pass --no-images or --raw (uses the source image, no Fal.ai)');

const anthropicClient = aiProvider === 'anthropic' ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const openrouterClient = aiProvider === 'openrouter' ? new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' }) : null;
const openaiClient = aiProvider === 'openai' ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (FAL_KEY) fal.config({ credentials: FAL_KEY });
const FAL_MODEL_IDS = { schnell: 'fal-ai/flux/schnell', dev: 'fal-ai/flux/dev', pro: 'fal-ai/flux-pro' };

const SITE_NICHE = {
  nxtsmarthome: 'smart home technology — connected devices, automation, reviews and how-to guides',
};
// Category slug -> OpenWeb Ninja news topic (topic headlines). Anything not
// here falls back to keyword /search, using SEARCH_TERM if set else the slug.
const TOPIC_MAP = {
  // indepthdaily section slugs
  'general-and-breaking-news': 'WORLD',
  'business-and-finance': 'BUSINESS',
  'sports': 'SPORTS',
  'lifestyle-and-health': 'HEALTH',
  'entertainment-and-culture': 'ENTERTAINMENT',
  'science-and-technology': 'TECHNOLOGY',
  // legacy / simple keys
  technology: 'TECHNOLOGY', tech: 'TECHNOLOGY', health: 'HEALTH', entertainment: 'ENTERTAINMENT',
  business: 'BUSINESS', science: 'SCIENCE', sport: 'SPORTS', world: 'WORLD', national: 'NATIONAL',
};
// Keyword-search categories (no matching Google News topic) -> a good query.
const SEARCH_TERM = {
  'politics': 'politics government elections',
  'property-and-real-estate': 'real estate housing market',
  'travel': 'travel',
};
// Fallback inference so ANY category read live from Strapi (including ones added
// later) still maps to a sensible Google News topic without editing this file.
const INFER_RULES = [
  [/tech|gadget|\bai\b|software|comput|digital/, 'TECHNOLOGY'],
  [/scien|research|climate|environment|space|physics|biolog/, 'SCIENCE'],
  [/health|wellness|fitness|medical|medicine|lifestyle|food|nutrition/, 'HEALTH'],
  [/business|financ|market|econom|money|corporate|stock|trade/, 'BUSINESS'],
  [/sport|athlet|football|soccer|basketball|cricket|tennis|nba|nfl/, 'SPORTS'],
  [/entertain|celebrit|movie|film|\btv\b|music|culture|showbiz/, 'ENTERTAINMENT'],
  [/breaking|world|global|international|headline/, 'WORLD'],
];
// Resolve a category (read live from Strapi) to a news source: an explicit topic
// or a keyword search. Precedence: --query override → topic map → keyword map →
// name/slug inference → de-slugged name as the search query.
function newsSourceFor(cat, queryOverride) {
  if (queryOverride) return { query: queryOverride };
  const slug = (cat.slug || '').toLowerCase();
  const name = (cat.name || '').toLowerCase();
  if (TOPIC_MAP[slug]) return { topic: TOPIC_MAP[slug] };
  if (SEARCH_TERM[slug]) return { query: SEARCH_TERM[slug] };
  for (const [re, topic] of INFER_RULES) if (re.test(name) || re.test(slug)) return { topic };
  return { query: (cat.name || slug.replace(/-/g, ' ')).trim() };
}
function sourceLabel(src) { return src.topic ? `topic ${src.topic}` : `search "${src.query}"`; }

/* ---------- OpenWeb Ninja news ---------- */
async function fetchNews({ source, count, country, lang }) {
  const base = OPENWEBNINJA_NEWS_BASE.replace(/\/$/, '');
  const url = source.topic
    ? `${base}/topic-headlines?topic=${source.topic}&country=${country}&lang=${lang}&limit=${count}`
    : `${base}/search?query=${encodeURIComponent(source.query)}&country=${country}&lang=${lang}&limit=${count}`;
  const res = await fetch(url, { headers: { 'x-api-key': OPENWEBNINJA_API_KEY } });
  if (!res.ok) throw new Error(`OpenWeb Ninja ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  const via = sourceLabel(source);
  return { via, items: (j.data || []).map((d) => ({
    title: d.title, link: d.link, snippet: d.snippet || '',
    image: d.photo_url || d.thumbnail_url || '', source: d.source_name || '', published: d.published_datetime_utc || '',
  })).filter((i) => i.title) };
}

/* ---------- full article extraction (from the source URL) ---------- */
const nhm = new NodeHtmlMarkdown();
async function fetchFullArticle(url) {
  try {
    const art = await extract(url, {}, { headers: { 'user-agent': 'Mozilla/5.0 (FXN news import)' }, signal: AbortSignal.timeout(20000) });
    if (!art?.content) return null;
    const md = nhm.translate(art.content).replace(/\n{3,}/g, '\n\n').trim();
    return md.length > 200 ? md : null; // ignore paywalled/empty extractions
  } catch { return null; }
}

/* ---------- Strapi ---------- */
async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRAPI_API_TOKEN}`, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Strapi ${res.status} on ${pathname}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}
const attr = (row, k) => row?.[k] ?? row?.attributes?.[k];
async function loadSites() {
  const j = await strapi('/api/gatsby-sites?pagination[pageSize]=100&sort[0]=name:asc');
  return (j.data || []).map((d) => ({ id: d.id, key: attr(d, 'key'), name: attr(d, 'name') }));
}
async function loadCategories(siteId) {
  const filter = siteId ? `&filters[sites][id][$eq]=${siteId}` : '';
  const j = await strapi(`/api/gatsby-categories?pagination[pageSize]=200&sort[0]=name:asc${filter}`);
  return (j.data || []).map((d) => ({ id: d.id, name: attr(d, 'name'), slug: attr(d, 'slug') }));
}

/* ---------- AI ---------- */
async function callAI({ system, user, maxTokens }) {
  if (aiProvider === 'openai') { const r = await openaiClient.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens }); return r.choices?.[0]?.message?.content?.trim() || ''; }
  if (aiProvider === 'openrouter') { const r = await openrouterClient.chat.completions.create({ model: OPENROUTER_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, extra_headers: { 'HTTP-Referer': OPENROUTER_SITE_URL, 'X-OpenRouter-Title': OPENROUTER_APP_NAME } }); return r.choices?.[0]?.message?.content?.trim() || ''; }
  const msg = await anthropicClient.messages.create({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
function providerName() { return aiProvider === 'openrouter' ? 'OpenRouter' : aiProvider === 'openai' ? 'OpenAI' : 'Claude'; }
function maxTokensEnv() { const v = aiProvider === 'openrouter' ? OPENROUTER_MAX_TOKENS : aiProvider === 'openai' ? OPENAI_MAX_OUTPUT_TOKENS : CLAUDE_MAX_TOKENS; return Math.max(parseInt(v, 10) || 0, 16000); }
function safeParse(s) { try { return JSON.parse(s); } catch { const m = s.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } } }

function systemPromptNews(lengthLabel, niche) {
  return `You are a staff news writer for a website about: ${niche}.
You are given a REAL news headline, snippet and source. Write an ORIGINAL, factual news article based on it.

# Rules
- Do NOT copy or closely paraphrase the source text. Write it fresh in your own words.
- Report only what can be reasonably grounded in the provided headline/snippet plus widely-known context. Do NOT invent quotes, statistics, names or specifics that aren't supported. Where details are unknown, stay general and say what is/ isn't yet known.
- Neutral, journalistic tone. Lead paragraph answers who/what/when/where/why.
- Include one sentence attributing the report to the original source by name.
- ${lengthLabel} words. Use H2 sub-headings and at least one bullet list where it fits.

# Output — strict JSON, no text outside it, no markdown fences:
{
  "title": string,          // rewritten, 50-70 chars, specific
  "slug": string,           // kebab-case, <60 chars
  "excerpt": string,        // 140-180 chars plain text
  "content": string,        // Markdown body, ${lengthLabel} words
  "seoTitle": string,       // <=65 chars
  "seoDescription": string, // <=158 chars
  "seoKeywords": string,    // comma separated 5-10
  "tags": string[],         // 4-8 lowercase
  "readingTimeMinutes": number,
  "imagePrompts": { "cover": string, "gallery": string[] }  // photographic, 16:9 cover + 2 gallery; no logos/brands/faces
}`;
}
function userPromptNews(item, category, fullText) {
  return [
    `Headline: ${item.title}`,
    item.snippet ? `Snippet: ${item.snippet}` : '',
    item.source ? `Original source: ${item.source}` : '',
    item.published ? `Published: ${item.published}` : '',
    category ? `Section/category: ${category}` : '',
    fullText ? `\nFull source article (reference only — rewrite in your OWN words, do not copy sentences verbatim):\n"""\n${fullText.slice(0, 6000)}\n"""` : '',
  ].filter(Boolean).join('\n');
}
async function generateArticleFromNews(item, { length, niche, category, fullText }) {
  const lengthLabel = ({ short: '350-550', medium: '650-950', long: '1100-1600' })[length];
  const text = await callAI({ system: systemPromptNews(lengthLabel, niche), user: userPromptNews(item, category, fullText), maxTokens: maxTokensEnv() });
  const json = safeParse(text);
  if (!json) throw new Error(`${providerName()} returned non-JSON:\n${text.slice(0, 300)}`);
  if (!json.title) json.title = item.title;
  if (!json.slug) json.slug = slugify(json.title, { lower: true, strict: true }).slice(0, 60);
  const t = (s, m) => (s && s.length > m ? s.slice(0, m - 1).trimEnd() + '…' : s);
  json.title = t(json.title, 255); json.seoTitle = t(json.seoTitle, 68); json.seoDescription = t(json.seoDescription, 158); json.excerpt = t(json.excerpt, 480);
  json.slug = String(json.slug).slice(0, 60);
  if (!Number.isInteger(json.readingTimeMinutes) || json.readingTimeMinutes < 1) json.readingTimeMinutes = 4;
  return json;
}

/* ---------- images ---------- */
async function generateImage(prompt, { aspect = 'landscape_16_9' } = {}) {
  const modelId = FAL_MODEL_IDS[argv['image-model']] || FAL_MODEL_IDS.schnell;
  const result = await fal.subscribe(modelId, { input: { prompt, image_size: aspect, num_images: 1, enable_safety_checker: true }, logs: false });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('Fal.ai returned no image');
  return url;
}
async function uploadImageToStrapi(imageUrl, filename) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const ab = await res.arrayBuffer();
  const ct = res.headers.get('content-type') || 'image/jpeg';
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('files', new Blob([ab], { type: ct }), `${filename}.${ext}`.slice(0, 120));
  const up = await fetch(`${STRAPI_URL}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` }, body: form });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text().catch(() => '')).slice(0, 160)}`);
  const u = await up.json(); const first = Array.isArray(u) ? u[0] : u;
  if (!first?.id) throw new Error('upload returned no id');
  return first.id;
}
async function makeImages(draft) {
  const p = draft?.imagePrompts;
  if (!p?.cover) return { coverId: null, galleryIds: [] };
  const base = slugify(draft.title || 'news', { lower: true, strict: true }).slice(0, 50);
  const jobs = [{ kind: 'cover', prompt: p.cover, aspect: 'landscape_16_9' }, ...(Array.isArray(p.gallery) ? p.gallery.slice(0, 2) : []).map((g, i) => ({ kind: `g-${i + 1}`, prompt: g, aspect: 'landscape_4_3' }))];
  process.stdout.write(`  generating ${jobs.length} image(s)… `);
  const results = await Promise.all(jobs.map(async (j) => ({ kind: j.kind, id: await uploadImageToStrapi(await generateImage(j.prompt, { aspect: j.aspect }), `${base}-${j.kind}`) })));
  process.stdout.write('done\n');
  return { coverId: results.find((r) => r.kind === 'cover')?.id ?? null, galleryIds: results.filter((r) => r.kind !== 'cover').map((r) => r.id) };
}

/* ---------- create ---------- */
async function createGatsbyPost(draft, opts) {
  const data = {
    title: draft.title, slug: draft.slug, excerpt: draft.excerpt, content: draft.content,
    postType: 'news', readingTimeMinutes: draft.readingTimeMinutes,
    seoTitle: draft.seoTitle, seoDescription: draft.seoDescription, seoKeywords: draft.seoKeywords,
    source: opts.source || 'ai', sourceUrl: opts.sourceUrl || undefined, sites: [opts.siteId],
  };
  if (opts.categoryId) data.categories = [opts.categoryId];
  if (opts.coverId) data.coverImage = opts.coverId;
  if (opts.galleryIds?.length) data.gallery = opts.galleryIds;
  if (opts.publish) data.publishedAt = new Date().toISOString();
  return strapi('/api/gatsby-posts', { method: 'POST', body: JSON.stringify({ data }) });
}

// Raw import: use the news item as-is (headline + full/snippet body + attribution), no AI.
function rawDraft(item, fullMd) {
  const title = (item.title || 'Untitled').slice(0, 255);
  const excerpt = (item.snippet || '').slice(0, 480);
  const src = item.source || 'the original source';
  const body = fullMd || item.snippet || '';
  const words = body ? body.split(/\s+/).length : 0;
  return {
    title,
    slug: slugify(title, { lower: true, strict: true }).slice(0, 60),
    excerpt,
    content: `${body}${body ? '\n\n' : ''}*Originally reported by [${src}](${item.link}). Read the full story at the source.*`,
    seoTitle: title.slice(0, 68),
    seoDescription: excerpt.slice(0, 158),
    seoKeywords: '',
    readingTimeMinutes: Math.max(1, Math.round(words / 200)),
  };
}

async function processItem(item, ctx) {
  console.log(`\n▸ ${item.title}  — ${item.source}`);
  let fullMd = null;
  if (ctx.full) {
    process.stdout.write('  fetching full article… ');
    fullMd = await fetchFullArticle(item.link);
    console.log(fullMd ? `${fullMd.split(/\s+/).length} words` : 'unavailable (falling back to snippet)');
  }
  const draft = ctx.raw ? rawDraft(item, fullMd) : await generateArticleFromNews(item, { ...ctx, fullText: fullMd });
  console.log(ctx.raw ? '  · raw import (no AI rewrite)' : `  ✓ wrote "${draft.title}" (${(draft.content || '').split(/\s+/).length} words)`);

  if (ctx.dryRun) {
    console.log('  [dry-run] would post:', JSON.stringify({ mode: ctx.raw ? 'raw' : 'ai', title: draft.title, slug: draft.slug, site: ctx.siteKey, category: ctx.categorySlug, image: ctx.raw ? (item.image || '(none)') : '(generated)', source: item.link }));
    return;
  }

  let coverId = null, galleryIds = [];
  if (ctx.images) {
    try {
      if (ctx.raw) {
        if (item.image) { coverId = await uploadImageToStrapi(item.image, draft.slug); console.log('  ✓ imported source featured image'); }
        else console.log('  (no source image on this item)');
      } else {
        ({ coverId, galleryIds } = await makeImages(draft));
      }
    } catch (e) { console.log(`  ! image step: ${e.message}`); }
  }

  const created = await createGatsbyPost(draft, { siteId: ctx.siteId, categoryId: ctx.categoryId, coverId, galleryIds, publish: ctx.publish, sourceUrl: item.link, source: ctx.raw ? 'manual' : 'ai' });
  console.log(`  ✓ ${ctx.publish ? 'published' : 'draft'} gatsby-post #${created?.data?.id} — /${draft.slug}`);
}

const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

/* ---------- interactive ---------- */
async function runInteractive() {
  console.log('\nFXN News Writer — interactive\n');
  const sites = await loadSites();
  if (!sites.length) fatal('No Gatsby sites in Strapi.');
  const siteId = await select({ message: 'Publish to which site?', default: sites.find((s) => s.key === 'indepthdaily')?.id, choices: sites.map((s) => ({ name: `${s.name} (${s.key})`, value: s.id })) });
  const site = sites.find((s) => s.id === siteId);

  const cats = await loadCategories(siteId);
  if (!cats.length) fatal(`No categories for ${site.key}. Create some first (they double as news sections).`);
  const catSlug = await select({
    message: 'Which category to source news for (and publish into)?',
    choices: cats.map((c) => ({ name: `${c.name}  → ${sourceLabel(newsSourceFor(c, argv.query))}`, value: c.slug })),
  });
  const category = cats.find((c) => c.slug === catSlug);

  process.stdout.write('  fetching headlines… ');
  const { via, items } = await fetchNews({ source: newsSourceFor(category, argv.query), count: argv.count, country: argv.country, lang: argv.lang });
  console.log(`${items.length} via ${via}`);
  if (!items.length) fatal('No news returned for that category.');

  const chosen = await checkbox({
    message: 'Select headlines to turn into articles:',
    pageSize: 15,
    choices: items.map((it, i) => ({ name: `${short(it.title, 90)}  · ${it.source}`, value: i })),
  });
  if (!chosen.length) { console.log('Nothing selected.'); return; }

  const raw = await select({
    message: 'How should selected headlines be imported?',
    default: false,
    choices: [
      { name: 'AI-rewrite into an original article (recommended)', value: false },
      { name: 'Raw import — headline + snippet + source image, no AI', value: true },
    ],
  });
  const length = raw ? 'short' : await select({ message: 'Article length?', default: 'medium', choices: [{ name: 'Short (~450w)', value: 'short' }, { name: 'Medium (~800w)', value: 'medium' }, { name: 'Long (~1300w)', value: 'long' }] });
  const full = await confirm({ message: raw ? 'Fetch the full article body from the source (instead of just the snippet)?' : 'Fetch each full source article to ground the rewrite?', default: true });
  const images = raw
    ? await confirm({ message: "Import each article's source featured image?", default: true })
    : (FAL_KEY ? await confirm({ message: 'Generate a featured image per article (Fal.ai FLUX)?', default: true }) : false);
  const publish = await confirm({ message: 'Publish immediately? (No = drafts)', default: false });

  const ctx = { siteId, siteKey: site.key, niche: SITE_NICHE[site.key] || site.name, categoryId: category.id, categorySlug: catSlug, raw, full, length, images, publish, dryRun: argv['dry-run'] };
  for (const idx of chosen) await processItem(items[idx], ctx);
  console.log(`\nDone — ${chosen.length} article(s). Rebuild the site to publish: /opt/gatsby/scripts/rebuild-site.sh ${site.key}`);
}

/* ---------- scripted ---------- */
async function runScripted() {
  const sites = await loadSites();
  const site = sites.find((s) => s.key === argv.site || String(s.id) === String(argv.site)) || fatal(`site "${argv.site}" not found`);
  const cats = await loadCategories(site.id);
  const category = cats.find((c) => c.slug === argv.category) || fatal(`category "${argv.category}" not on ${site.key}`);
  const { via, items } = await fetchNews({ source: newsSourceFor(category, argv.query), count: argv.count, country: argv.country, lang: argv.lang });
  console.log(`fetched ${items.length} via ${via}`);
  const take = items.slice(0, argv.pick || 1);
  const ctx = { siteId: site.id, siteKey: site.key, niche: SITE_NICHE[site.key] || site.name, categoryId: category.id, categorySlug: argv.category, raw: argv.raw, full: argv.full, length: argv.length, images: argv.images, publish: argv.publish, dryRun: argv['dry-run'] };
  for (const it of take) await processItem(it, ctx);
}

async function main() {
  if (!argv.interactive && argv.site && argv.category && (argv.pick || argv['dry-run'])) return runScripted();
  if (argv.interactive || process.stdin.isTTY) return runInteractive();
  fatal('Run interactively, or pass --site --category --pick N. See --help.');
}
main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
