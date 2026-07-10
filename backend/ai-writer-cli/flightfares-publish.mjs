#!/usr/bin/env node
// flightfares-publish.mjs
// Generate a travel article with Claude and post it to the flightfares.one
// WordPress site via the WP REST API, as a draft by default.
//
// Reuses the same Claude prompt rules as generate.js (the Strapi AI writer),
// but the destination is WordPress instead of Strapi.
//
// Quick use:
//   node flightfares-publish.mjs "How to find cheap last-minute flights"
//   node flightfares-publish.mjs --count 3 --category flights        # Claude invents titles
//   node flightfares-publish.mjs "..." --publish                     # publish live instead of draft
//   node flightfares-publish.mjs "..." --dry-run                     # generate only, no WP call (no creds needed)
//
// Required env (in .env or shell), only when actually posting:
//   WP_URL=https://www.flightfares.one
//   WP_USER=<wordpress username>
//   WP_APP_PASSWORD=<application password from Users -> Profile -> Application Passwords>
// Required for generation:
//   ANTHROPIC_API_KEY=...
// Optional (cover image):
//   FAL_KEY=...   (omit or pass --no-images to skip)

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fal } from '@fal-ai/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { select, input, confirm, checkbox } from '@inquirer/prompts';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [topic] [options]')
  .option('count', { alias: 'n', type: 'number', describe: 'Brainstorm N titles for --category and write each' })
  .option('category', { alias: 'c', type: 'string', default: 'flights', describe: 'WP category slug/name (created if missing)' })
  .option('tone', { type: 'string', default: 'friendly', choices: ['friendly', 'professional', 'adventurous', 'witty', 'luxury'] })
  .option('length', { alias: 'l', type: 'string', default: 'long', choices: ['short', 'medium', 'long'] })
  .option('keywords', { alias: 'k', type: 'string' })
  .option('language', { type: 'string', default: 'English' })
  .option('publish', { type: 'boolean', default: false, describe: 'Publish live (default: save as draft)' })
  .option('images', { type: 'boolean', default: true, describe: 'Generate + upload a Fal.ai cover image (use --no-images to skip)' })
  .option('image-model', { type: 'string', default: 'schnell', choices: ['schnell', 'dev', 'pro'] })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Generate only; print result, do not touch WordPress' })
  .option('interactive', { alias: 'i', type: 'boolean', default: false, describe: 'Force the interactive wizard even if flags are set' })
  .help()
  .parseSync();

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  CLAUDE_MAX_TOKENS = '16000',
  WP_URL = 'https://www.flightfares.one',
  WP_USER,
  WP_APP_PASSWORD,
  FAL_KEY,
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in env/.env');
  process.exit(1);
}
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const FAL_MODEL_IDS = {
  schnell: 'fal-ai/flux/schnell',
  dev: 'fal-ai/flux/dev',
  pro: 'fal-ai/flux-pro/v1.1',
};

// Reference taxonomy on flightfares.one (mirrors wp-admin → Posts → Categories).
// Used as a fallback when the live API can't be reached, and to keep slugs canonical.
// `parent` is the parent slug, or null for a top-level category.
const KNOWN_CATEGORIES = [
  { slug: 'accommodation', name: 'Accommodation', parent: null },
  { slug: 'activities', name: 'Activities', parent: null },
  { slug: 'destinations', name: 'Destinations', parent: null },
  { slug: 'flights', name: 'Flights', parent: null },
  { slug: 'food-drink', name: 'Food & Drink', parent: null },
  { slug: 'planning', name: 'Planning', parent: null },
  { slug: 'travel-tips', name: 'Travel Tips', parent: null },
  { slug: 'budget-tips', name: 'Budget Tips', parent: 'travel-tips' },
  { slug: 'itineraries', name: 'Itineraries', parent: 'travel-tips' },
  { slug: 'language', name: 'Language', parent: 'travel-tips' },
  { slug: 'travel-safety', name: 'Travel Safety', parent: 'travel-tips' },
  { slug: 'travel-types', name: 'Travel Types', parent: null },
  { slug: 'adventure', name: 'Adventure', parent: 'travel-types' },
  { slug: 'backpacking', name: 'Backpacking', parent: 'travel-types' },
  { slug: 'budget-travel', name: 'Budget Travel', parent: 'travel-types' },
  { slug: 'eco-tourism', name: 'Eco-Tourism', parent: 'travel-types' },
  { slug: 'family', name: 'Family', parent: 'travel-types' },
];
const KNOWN_SLUGS = new Set(KNOWN_CATEGORIES.map((c) => c.slug));

const wantImages = argv.images && !!FAL_KEY && !argv['dry-run'];
const wpAuth = WP_USER && WP_APP_PASSWORD
  ? 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64')
  : null;

/* ---------- Claude prompts (mirrors generate.js voice rules) ---------- */

function systemPromptArticle(lengthLabel) {
  return `You are a senior travel journalist writing for a travel blog focused on flights and airfares.

# Output
Return your answer by calling the emit_article tool. The "content" field is the
Markdown body, ${lengthLabel} words, with H2/H3 headings, bullet lists, and a
strong closing CTA. The "imagePrompts.cover" field is a photographic 16:9 hero
prompt (specific location/subject, time of day, lighting, lens hint; no faces,
logos, or brand names; 30-60 words).

# Voice
Write like Wirecutter or The Points Guy — not a brochure.
- First-person where it helps ("I booked…", "we found…"). Contractions OK.
- Opinions stated plainly; say what's worth it and what isn't.
- Concrete over abstract. Evidence over vibes.

# Banned phrases (never use ANY — they are AI tells)
nestled · hidden gem · bustling · a stone's throw · picture-perfect · must-see · must-visit · world-class · charming · quaint · vibrant · breathtaking · stunning · magical · unique · diverse · plethora · myriad · a variety of · truly · simply · whether you're · rest assured · look no further · immerse yourself · embark on · a journey · gateway to · tapestry · haven · jewel · treasure · oasis

# Banned openings
"Picture this…" / "Imagine…" / "Welcome to…" / "In a world where…" / "When it comes to…" / "Whether you're a seasoned traveler or…" / "Have you ever wondered…"

# Banned closings
"In conclusion…" / "To sum up…" / "At the end of the day…" / generic "book your trip today" CTAs — give a concrete next step instead.

# Concreteness rules
Every H2 section must include AT LEAST ONE of: an exact price in USD; a named airport/terminal/airline; a specific month or date range; a measured distance or time.

# Structure
- Lead with a 1-2 sentence hook making one concrete promise.
- Scannable, search-friendly H2s; H3s for sub-points.
- Bullet lists for anything comparative, numeric, or sequential (at least 1-2 sections).
- One honest tradeoff per 400-500 words.
- End with a concrete, actionable next step.

# Facts
Ground everything in real, verifiable facts. Do not invent precise numbers — generalise ("typically under $100") when exact figures aren't reliably known.`;
}

function userPromptArticle(p) {
  const words = ({ short: '400-600', medium: '800-1200', long: '1500-2200' })[p.length];
  return [
    `Topic: ${p.topic}`,
    p.category ? `Category: ${p.category}` : '',
    p.tone ? `Tone: ${p.tone}` : '',
    p.keywords ? `Keywords to weave in: ${p.keywords}` : '',
    p.language ? `Language: ${p.language}` : '',
    `Target length: ${words} words`,
    `Year context: 2026.`,
  ].filter(Boolean).join('\n');
}

function systemPromptTitles() {
  return `You are a senior travel editor producing fresh, SEO-optimised article title ideas for a travel blog.
Return them via the emit_titles tool.
Each title: 50-70 chars, specific, actionable, clickable (numbers, years, concrete places/routes allowed).
Titles must be DISTINCT — no near-duplicates. Match the requested category.`;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

// Pull the tool_use input object out of a response (forced structured output).
function toolInput(msg) {
  const block = msg.content.find((b) => b.type === 'tool_use');
  return block ? block.input : null;
}

const TITLES_TOOL = {
  name: 'emit_titles',
  description: 'Return the list of article titles.',
  input_schema: {
    type: 'object',
    properties: { titles: { type: 'array', items: { type: 'string' } } },
    required: ['titles'],
  },
};

const ARTICLE_TOOL = {
  name: 'emit_article',
  description: 'Return the finished article and its metadata.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '50-70 chars, SEO-optimised' },
      slug: { type: 'string', description: 'kebab-case ASCII, <60 chars' },
      excerpt: { type: 'string', description: '140-180 chars, plain text hook' },
      content: { type: 'string', description: 'Markdown body with H2/H3 headings, bullet lists, and a strong closing CTA' },
      seoTitle: { type: 'string', description: '<= 65 chars' },
      seoDescription: { type: 'string', description: '<= 158 chars' },
      tags: { type: 'array', items: { type: 'string' }, description: '4-8 lowercase tags' },
      readingTimeMinutes: { type: 'integer' },
      imagePrompts: {
        type: 'object',
        properties: { cover: { type: 'string', description: 'Photographic 16:9 hero prompt, 30-60 words, no logos/brands/faces' } },
        required: ['cover'],
      },
    },
    required: ['title', 'slug', 'excerpt', 'content', 'tags', 'imagePrompts'],
  },
};

async function generateTitles({ category, count, tone, language, keywords }) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: systemPromptTitles(),
    tools: [TITLES_TOOL],
    tool_choice: { type: 'tool', name: 'emit_titles' },
    messages: [{ role: 'user', content: [
      `Category: ${category}`, `Number of titles: ${count}`, `Tone: ${tone}`,
      `Language: ${language}`, keywords ? `Keywords: ${keywords}` : '', `Year context: 2026.`,
      `Return exactly ${count} titles.`,
    ].filter(Boolean).join('\n') }],
  });
  const json = toolInput(msg);
  if (!json || !Array.isArray(json.titles)) throw new Error(`No titles returned (stop=${msg.stop_reason})`);
  const seen = new Set();
  return json.titles.map((t) => String(t).trim())
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, count);
}

async function generateArticle(p) {
  const lengthLabel = ({ short: '400-600', medium: '800-1200', long: '1500-2200' })[p.length];
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: Math.max(parseInt(CLAUDE_MAX_TOKENS, 10) || 0, 16000),
    system: systemPromptArticle(lengthLabel),
    tools: [ARTICLE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_article' },
    messages: [{ role: 'user', content: userPromptArticle(p) }],
  });
  const json = toolInput(msg);
  if (!json) throw new Error(`Claude returned no article (stop=${msg.stop_reason})`);
  if (!json.slug) json.slug = slugify(json.title || p.topic, { lower: true, strict: true });
  json.slug = slugify(json.slug, { lower: true, strict: true }).slice(0, 60);
  return json;
}

/* ---------- Minimal Markdown -> HTML (covers headings, lists, bold/italic/links/code) ---------- */

function inline(s) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

function mdToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); flushList();
      const lvl = Math.min(m[1].length, 6);
      out.push(`<h${lvl}>${inline(m[2].trim())}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1].trim())}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1].trim())}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote><p>${inline(m[1].trim())}</p></blockquote>`);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

/* ---------- WordPress REST helpers ---------- */

async function wp(path, { method = 'GET', body, raw } = {}) {
  const headers = { Accept: 'application/json' };
  if (wpAuth) headers.Authorization = wpAuth;
  if (body && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${WP_URL}/wp-json${path}`, {
    method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = txt; }
  if (!res.ok) throw new Error(`WP ${method} ${path} -> ${res.status}: ${typeof json === 'string' ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// Find a term by slug/name in a taxonomy, creating it if missing. Returns its id.
async function ensureTerm(taxonomy, nameOrSlug) {
  const slug = slugify(nameOrSlug, { lower: true, strict: true });
  const found = await wp(`/wp/v2/${taxonomy}?slug=${encodeURIComponent(slug)}&_fields=id,name,slug`);
  if (Array.isArray(found) && found.length) return found[0].id;
  const created = await wp(`/wp/v2/${taxonomy}`, { method: 'POST', body: { name: nameOrSlug, slug } });
  return created.id;
}

async function generateCover(prompt) {
  const modelId = FAL_MODEL_IDS[argv['image-model']] || FAL_MODEL_IDS.schnell;
  const result = await fal.subscribe(modelId, {
    input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true },
    logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('Fal.ai returned no image URL');
  return url;
}

async function uploadMedia(imageUrl, filename, altText) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`download image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'image/jpeg';
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  const name = `${slugify(filename, { lower: true, strict: true }).slice(0, 80)}.${ext}`;
  const headers = { Authorization: wpAuth, 'Content-Type': ct, 'Content-Disposition': `attachment; filename="${name}"` };
  const r = await fetch(`${WP_URL}/wp-json/wp/v2/media`, { method: 'POST', headers, body: buf });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  if (!r.ok) throw new Error(`WP media upload ${r.status}: ${String(typeof j === 'string' ? j : JSON.stringify(j)).slice(0, 300)}`);
  if (altText) { try { await wp(`/wp/v2/media/${j.id}`, { method: 'POST', body: { alt_text: altText } }); } catch {} }
  return j.id;
}

/* ---------- main ---------- */

async function buildOne(topic) {
  console.log(`\n✍️  Generating: ${topic}`);
  const draft = await generateArticle({
    topic, category: argv.category, tone: argv.tone, length: argv.length,
    keywords: argv.keywords, language: argv.language,
  });

  const html = mdToHtml(draft.content);
  console.log(`   title: ${draft.title}`);
  console.log(`   slug:  ${draft.slug}  (${(draft.content || '').split(/\s+/).length} words md)`);

  if (argv['dry-run']) {
    console.log('   --dry-run: not posting. HTML preview (first 400 chars):');
    console.log('   ' + html.slice(0, 400).replace(/\n/g, '\n   '));
    return { dryRun: true, draft };
  }

  if (!wpAuth) {
    console.error('   ✗ Missing WP_USER / WP_APP_PASSWORD — cannot post. Set them in .env or run with --dry-run.');
    process.exit(1);
  }

  // Featured image (optional)
  let featured = 0;
  if (wantImages && draft.imagePrompts?.cover) {
    try {
      console.log('   🖼  generating cover image…');
      const url = await generateCover(draft.imagePrompts.cover);
      featured = await uploadMedia(url, draft.slug, draft.title);
      console.log(`   🖼  uploaded media id ${featured}`);
    } catch (e) { console.warn(`   ⚠ cover image skipped: ${e.message}`); }
  }

  // Taxonomy
  const categoryId = await ensureTerm('categories', argv.category);
  const tagIds = [];
  for (const t of (draft.tags || []).slice(0, 8)) {
    try { tagIds.push(await ensureTerm('tags', t)); } catch (e) { console.warn(`   ⚠ tag "${t}" skipped: ${e.message}`); }
  }

  const post = await wp('/wp/v2/posts', {
    method: 'POST',
    body: {
      title: draft.title,
      slug: draft.slug,
      content: html,
      excerpt: draft.excerpt || '',
      status: argv.publish ? 'publish' : 'draft',
      categories: [categoryId],
      tags: tagIds,
      ...(featured ? { featured_media: featured } : {}),
    },
  });
  console.log(`   ✅ ${argv.publish ? 'PUBLISHED' : 'DRAFT'} #${post.id} → ${post.link}`);
  console.log(`      edit: ${WP_URL}/wp-admin/post.php?post=${post.id}&action=edit`);
  return post;
}

const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&#0?38;/g, '&');

// Pull the live category list from flightfares.one so the wizard offers real options.
// Falls back to the baked-in KNOWN_CATEGORIES taxonomy if the API is unreachable.
async function fetchWpCategories() {
  try {
    const cats = await wp('/wp/v2/categories?per_page=100&_fields=id,name,slug,count,parent');
    if (Array.isArray(cats) && cats.length) return cats.map((c) => ({ ...c, name: decode(c.name) }));
  } catch { /* fall through */ }
  // Offline fallback: synthesise the same shape from KNOWN_CATEGORIES (parent as slug → resolved to a marker).
  const idForSlug = (slug) => KNOWN_CATEGORIES.findIndex((c) => c.slug === slug) + 1;
  return KNOWN_CATEGORIES.map((c, i) => ({ id: i + 1, name: c.name, slug: c.slug, count: 0, parent: c.parent ? idForSlug(c.parent) : 0 }));
}

// Order categories as a parent → indented-children tree (matching wp-admin), and
// build inquirer choices with "— " prefixes for child terms.
function categoryChoices(cats) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const tops = cats.filter((c) => !c.parent || !byId.has(c.parent)).sort((a, b) => a.name.localeCompare(b.name));
  const childrenOf = (id) => cats.filter((c) => c.parent === id).sort((a, b) => a.name.localeCompare(b.name));
  const choices = [];
  for (const t of tops) {
    if (t.slug === 'uncategorized') continue;
    choices.push({ name: `${t.name}${t.count ? ` (${t.count})` : ''}`, value: t.slug });
    for (const k of childrenOf(t.id)) {
      choices.push({ name: `   — ${k.name}${k.count ? ` (${k.count})` : ''}`, value: k.slug });
    }
  }
  return choices;
}

// Interactive wizard — returns the list of topics to generate, mutating argv with the chosen settings.
async function runWizard() {
  console.log('\n🛫  flightfares.one — article generator\n');

  // 1) Category — shown as the live wp-admin tree (parents + indented children)
  const cats = await fetchWpCategories();
  const catChoices = categoryChoices(cats);
  catChoices.push({ name: '➕  New category…', value: '__new__' });
  let category = await select({ message: 'Category', choices: catChoices, default: catChoices.find((c) => c.value === 'flights') ? 'flights' : catChoices[0]?.value });
  if (category === '__new__') category = (await input({ message: 'New category name' })).trim();
  argv.category = category;

  // 2) How to pick topics
  const mode = await select({
    message: 'How should topics be chosen?',
    choices: [
      { name: 'Let Claude brainstorm titles for me', value: 'brainstorm' },
      { name: "I'll type the topic(s) myself", value: 'manual' },
    ],
  });

  let topics = [];
  if (mode === 'brainstorm') {
    const count = Number(await input({ message: 'How many posts?', default: '3', validate: (v) => (Number(v) > 0 && Number(v) <= 25) || '1-25' }));
    argv.count = count;
  } else {
    const raw = await input({ message: 'Topic(s) — separate multiple with "|"', validate: (v) => v.trim().length > 0 || 'enter at least one topic' });
    topics = raw.split('|').map((s) => s.trim()).filter(Boolean);
  }

  // 3) Shared settings
  argv.keywords = (await input({ message: 'Keywords to weave in (optional, comma-separated)', default: argv.keywords || '' })).trim() || undefined;
  argv.tone = await select({ message: 'Tone', default: argv.tone, choices: ['friendly', 'professional', 'adventurous', 'witty', 'luxury'].map((v) => ({ name: v, value: v })) });
  argv.length = await select({ message: 'Length', default: argv.length, choices: [
    { name: 'short (400-600 words)', value: 'short' },
    { name: 'medium (800-1200 words)', value: 'medium' },
    { name: 'long (1500-2200 words)', value: 'long' },
  ] });

  if (FAL_KEY) argv.images = await confirm({ message: 'Generate + attach an AI cover image?', default: true });
  else { argv.images = false; console.log('   (no FAL_KEY set — skipping cover images)'); }

  const status = await select({ message: 'Publish status', default: argv.publish ? 'publish' : 'draft', choices: [
    { name: 'Draft (review in wp-admin before going live)', value: 'draft' },
    { name: 'Publish live immediately', value: 'publish' },
  ] });
  argv.publish = status === 'publish';

  // 4) Brainstorm titles now (so the user can confirm them before writing)
  if (mode === 'brainstorm') {
    console.log(`\n🧠 Brainstorming ${argv.count} "${argv.category}" titles…`);
    const ideas = await generateTitles({ category: argv.category, count: argv.count, tone: argv.tone, language: argv.language, keywords: argv.keywords });
    topics = await checkbox({
      message: 'Pick the titles to write (space to toggle, enter to confirm)',
      choices: ideas.map((t) => ({ name: t, value: t, checked: true })),
      required: true,
    });
  }

  // 5) Final confirm
  console.log(`\nReady: ${topics.length} post(s) · category "${argv.category}" · ${argv.length} · ${argv.tone} · ${argv.publish ? 'PUBLISH' : 'draft'}${argv.images ? ' · +cover image' : ''}`);
  if (!(await confirm({ message: 'Generate and post now?', default: true }))) { console.log('Cancelled.'); process.exit(0); }
  return topics;
}

(async () => {
  let topics = [];
  const positional = argv._.map(String).filter(Boolean);
  const noJob = !positional.length && !(argv.count && argv.count > 0);

  if (argv.interactive || noJob) {
    topics = await runWizard();
  } else if (argv.count && argv.count > 0) {
    console.log(`🧠 Brainstorming ${argv.count} "${argv.category}" titles…`);
    topics = await generateTitles({ category: argv.category, count: argv.count, tone: argv.tone, language: argv.language, keywords: argv.keywords });
    topics.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));
  } else {
    topics = positional;
  }

  for (const t of topics) {
    try { await buildOne(t); } catch (e) { console.error(`   ✗ failed "${t}": ${e.message}`); }
  }
})();
