#!/usr/bin/env node
// Generate SEO articles for fxnseo.com (fxnSEOTools) and post them to Strapi
// as the `fxnseo-post` collection type.
//
// Flow: pick an SEO tool (from fxnseo-tools.json) -> generate article(s) about
// that tool -> weave in internal links (tool page + resources hub + related
// posts) -> optionally generate a feature/cover image with Fal.ai -> save to
// Strapi as a draft (or --publish). A --delete mode removes existing posts.
//
// Modeled on generate-site-post.js. The fxnseo-post schema is intentionally
// minimal: title, slug, excerpt, content (markdown), coverImage, seoTitle,
// seoDescription.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fal } from '@fal-ai/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { input, select, checkbox } from '@inquirer/prompts';
import { parseAiJson } from './parse-ai-json.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// SumoSEO (Laravel) native-blog importer — publishes the same article into the
// app's pages/page_translations so it appears under /admin/posts and /blog.
const SUMOSEO_APP_DIR = process.env.SUMOSEO_APP_DIR || '/var/www/html/fxnseo.com/components';
const SUMOSEO_IMPORTER = path.join(SUMOSEO_APP_DIR, 'sumoseo-import-post.php');
const SUMOSEO_RUN_AS = process.env.SUMOSEO_RUN_AS || 'www-data';

const SITE = {
  label: 'fxnSEOTools',
  siteUrl: 'https://fxnseo.com',
  postEndpoint: '/api/fxnseo-posts',
  adminUid: 'api::fxnseo-post.fxnseo-post',
  toolsFile: 'fxnseo-tools.json',
  editorialBrief:
    'Write an authoritative, genuinely useful article for fxnSEOTools (https://fxnseo.com), a free online SEO tools platform. Educate readers about the selected SEO tool: what it does, why it matters for SEO, how to use it step by step, best practices, common mistakes to avoid, and how fxnSEOTools makes the task quick and free. Keep the tone practical and trustworthy.',
  topicNiche:
    'SEO tools, search engine optimization, technical SEO, digital marketing, website analysis, webmaster utilities, content optimization',
};

const RESOURCES_URL = `${SITE.siteUrl}/resources`;
const toolPageUrl = (slug) => `${SITE.siteUrl}/${slug}`;

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [--tool <slug>] [topic] [options]')
  .option('tool', {
    type: 'string',
    describe: 'SEO tool slug the article is about (see fxnseo-tools.json). Prompts when omitted.',
  })
  .option('topic', { alias: 't', type: 'string', describe: 'Single article topic/title' })
  .option('count', {
    alias: 'n',
    type: 'number',
    describe: 'How many articles to brainstorm for the selected tool',
  })
  .option('tone', {
    type: 'string',
    default: 'helpful',
    choices: ['helpful', 'professional', 'friendly', 'witty', 'authoritative'],
  })
  .option('length', {
    alias: 'l',
    type: 'string',
    choices: ['medium', 'long', 'very-long'],
    describe: 'Article length target. Prompts when omitted in an interactive terminal.',
  })
  .option('keywords', { alias: 'k', type: 'string', describe: 'Comma-separated SEO keywords' })
  .option('language', { type: 'string', default: 'English' })
  .option('target', {
    type: 'string',
    default: 'both',
    choices: ['both', 'strapi', 'native'],
    describe: 'Where to save: Strapi /resources, the SumoSEO native /blog, or both.',
  })
  .option('publish', { type: 'boolean', default: false, describe: 'Publish immediately; default is draft' })
  .option('images', {
    type: 'boolean',
    describe: 'Generate a cover feature image with Fal.ai. Use --no-images to skip. Prompts when omitted.',
  })
  .option('image-model', {
    type: 'string',
    default: 'schnell',
    choices: ['schnell', 'dev', 'pro'],
    describe: 'Fal.ai FLUX variant',
  })
  .option('delete', {
    type: 'boolean',
    default: false,
    describe: 'Interactively delete existing fxnseo.com posts instead of generating.',
  })
  .option('import-strapi', {
    type: 'boolean',
    default: false,
    describe: 'Backfill: import existing Strapi articles into the SumoSEO native blog (/admin/posts, /blog). Skips slugs that already exist.',
  })
  .option('add-images', {
    type: 'boolean',
    default: false,
    describe: 'Generate a Fal.ai cover image for every article missing one and attach it to Strapi + the native blog.',
  })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Generate JSON only; do not write to Strapi' })
  .help()
  .parseSync();

const positionalTopic = argv._[0];
if (!argv.topic && positionalTopic) argv.topic = String(positionalTopic);

const {
  AI_PROVIDER = 'openai',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-5.5',
  OPENAI_MAX_OUTPUT_TOKENS = '16000',
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = '~openai/gpt-latest',
  OPENROUTER_MAX_TOKENS = '16000',
  OPENROUTER_SITE_URL = 'https://fxnseo.com',
  OPENROUTER_APP_NAME = 'FXN AI Writer CLI',
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-5-20250929',
  CLAUDE_MAX_TOKENS = '16000',
  STRAPI_URL,
  STRAPI_API_TOKEN,
  STRAPI_PUBLIC_URL,
  FAL_KEY,
} = process.env;

const aiProvider = AI_PROVIDER.toLowerCase();
if (!['openai', 'openrouter', 'anthropic'].includes(aiProvider)) fatal('AI_PROVIDER must be "openai", "openrouter", or "anthropic".');
if (aiProvider === 'openai' && !OPENAI_API_KEY) fatal('OPENAI_API_KEY is not set.');
if (aiProvider === 'openrouter' && !OPENROUTER_API_KEY) fatal('OPENROUTER_API_KEY is not set.');
if (aiProvider === 'anthropic' && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set.');
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
}

const anthropicClient = aiProvider === 'anthropic' ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const openaiClient = aiProvider === 'openai' ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const openrouterClient = aiProvider === 'openrouter'
  ? new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
  : null;
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const FAL_MODEL_IDS = {
  schnell: 'fal-ai/flux/schnell',
  dev: 'fal-ai/flux/dev',
  pro: 'fal-ai/flux-pro',
};

const ARTICLE_LENGTH_TARGETS = {
  medium: { label: 'Medium', words: '1000-1300' },
  long: { label: 'Long', words: '1500-2200' },
  'very-long': { label: 'Very long', words: '2200-3000' },
};

// ---------------------------------------------------------------------------
// Strapi helper
// ---------------------------------------------------------------------------

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
    const detail = await res.text();
    throw new Error(`Strapi ${res.status} on ${pathname}: ${detail.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Tools list
// ---------------------------------------------------------------------------

function loadTools() {
  const file = path.join(SCRIPT_DIR, SITE.toolsFile);
  if (!fs.existsSync(file)) {
    fatal(`Tools file not found: ${file}. Expected a JSON array of { "slug", "name" }.`);
  }
  const tools = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(tools) || !tools.length) fatal(`No tools found in ${file}.`);
  return tools;
}

function toolBySlug(slug) {
  const tools = loadTools();
  return tools.find((t) => t.slug === slug) || { slug, name: titleCase(slug) };
}

async function promptForTool() {
  const tools = loadTools();
  return select({
    message: 'Which SEO tool should the article be about?',
    choices: tools.map((t) => ({ name: `${t.name} (${t.slug})`, value: t.slug })),
    pageSize: 15,
  });
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

async function promptForMissingOptions() {
  if (!argv.tool) argv.tool = await promptForTool();

  if (!argv.topic && !argv.count) {
    const mode = await select({
      message: 'What do you want to generate?',
      choices: [
        { name: 'One comprehensive guide for this tool', value: 'single' },
        { name: 'Brainstorm several article angles for this tool', value: 'count' },
        { name: 'Write one specific topic', value: 'topic' },
      ],
    });

    if (mode === 'topic') {
      argv.topic = await input({
        message: 'Article topic/title:',
        validate: (value) => (String(value).trim() ? true : 'Enter a topic.'),
      });
    } else if (mode === 'count') {
      const answer = await input({
        message: 'How many articles should I generate?',
        default: '3',
        validate: (value) => {
          const n = Number(value);
          return Number.isInteger(n) && n > 0 ? true : 'Enter a positive whole number.';
        },
      });
      argv.count = Number(answer);
    }
  }

  if (argv.images === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      argv.images = await select({
        message: 'Generate a feature (cover) image for each post?',
        choices: [
          { name: 'Yes, generate a feature image', value: true },
          { name: 'No, text only', value: false },
        ],
      });
    } else {
      argv.images = false;
    }
  }

  if (argv.images && !argv['dry-run'] && !FAL_KEY) {
    fatal('FAL_KEY is not set in .env. Get one at https://fal.ai/dashboard/keys - or pass --no-images to skip image generation.');
  }

  if (!lengthWasProvided() && process.stdin.isTTY && process.stdout.isTTY) {
    argv.length = await select({
      message: 'How long should each article be?',
      choices: [
        { name: 'Medium (about 1,000-1,300 words)', value: 'medium' },
        { name: 'Long (about 1,500-2,200 words)', value: 'long' },
        { name: 'Very long (about 2,200-3,000 words)', value: 'very-long' },
      ],
      default: 'long',
    });
  } else if (!argv.length) {
    argv.length = 'long';
  }
}

// ---------------------------------------------------------------------------
// Topic brainstorming
// ---------------------------------------------------------------------------

async function brainstormToolTopics(tool, count) {
  const prompt = `Brainstorm ${count} specific, search-optimized article titles for fxnSEOTools about the "${tool.name}" tool.

Tool page: ${toolPageUrl(tool.slug)}
Site niche: ${SITE.topicNiche}
Language: ${argv.language}

Return STRICT JSON only:
{
  "topics": ["title one", "title two"]
}

Rules:
- Every title must be about the "${tool.name}" tool or the exact SEO problem it solves.
- Mix angles: how-to, step-by-step guide, best practices, common mistakes, and comparisons.
- Make each title specific, useful, and clickable without being spammy.
- Avoid duplicate wording. Avoid years unless the topic genuinely needs one.`;

  const result = await callAI({
    system: 'You are a senior SEO editorial strategist. Return only valid JSON.',
    user: prompt,
    maxTokens: 1200,
  });
  const parsed = parseAiJson(result, { providerName: activeProviderName() });
  const topics = Array.isArray(parsed?.topics) ? parsed.topics : [];
  if (!topics.length) throw new Error(`${activeProviderName()} did not return any topics.`);
  return topics.slice(0, count);
}

async function buildJobs() {
  const tool = toolBySlug(argv.tool);

  if (argv.topic) return [{ topic: argv.topic, tool }];

  if (argv.count && argv.count > 1) {
    const topics = await brainstormToolTopics(tool, argv.count);
    return topics.map((topic) => ({ topic, tool }));
  }

  return [{ topic: `${tool.name}: The Complete Guide`, tool }];
}

// ---------------------------------------------------------------------------
// Related posts (for internal linking)
// ---------------------------------------------------------------------------

async function fetchRelatedPosts(excludeSlug, limit = 4) {
  if (argv['dry-run']) return [];
  try {
    const res = await strapi(
      `${SITE.postEndpoint}?fields[0]=title&fields[1]=slug&sort=publishedAt:desc&pagination[pageSize]=${limit + 1}`,
    );
    const data = res?.data || [];
    return data
      .map((item) => ({ title: item.title, slug: item.slug }))
      .filter((item) => item.slug && item.slug !== excludeSlug)
      .slice(0, limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Article generation
// ---------------------------------------------------------------------------

async function generatePost(topic, tool, relatedPosts = []) {
  const lengthConfig = resolveArticleLengthConfig();

  const relatedLinksBlock = relatedPosts.length
    ? `\nRelated fxnSEOTools resources you may link to where genuinely relevant (use the resource path):\n${relatedPosts
        .map((p) => `- ${p.title}: ${SITE.siteUrl}/resources/${p.slug}`)
        .join('\n')}\n`
    : '';

  const prompt = `${SITE.editorialBrief}

Write one complete blog article.

Topic: ${topic}
Primary SEO tool: ${tool.name}
Tool page URL (primary internal link): ${toolPageUrl(tool.slug)}
Resources hub URL (secondary internal link): ${RESOURCES_URL}
Tone: ${argv.tone}
Length: ${lengthConfig.words} words
Language: ${argv.language}
SEO keywords: ${argv.keywords || `choose natural keywords around "${tool.name}" and its SEO use case`}
${relatedLinksBlock}
Return STRICT JSON only with exactly these keys:
{
  "title": string,
  "slug": string,
  "excerpt": string,
  "content": string,
  "seoTitle": string,
  "seoDescription": string,
  "seoKeywords": string,
  "readingTimeMinutes": number,
  "imagePrompts": {
    "cover": string
  }
}

Content requirements:
- Markdown only in "content". Do not include markdown code fences.
- Center the entire article on the "${tool.name}" tool and the SEO tasks it helps with.
- Use useful H2/H3 headings, short paragraphs, and bullet lists where helpful.
- Include a clear, natural step-by-step "How to use the ${tool.name}" section.
- Include at least one contextual internal link in Markdown to the tool page: [${tool.name}](${toolPageUrl(tool.slug)}).
- Include one internal link to the resources hub: [more SEO resources](${RESOURCES_URL}).
${relatedPosts.length ? '- Where genuinely relevant, link to one or two of the related fxnSEOTools resources listed above.' : ''}
- End with a short call-to-action inviting readers to try the ${tool.name} for free on fxnSEOTools.
- Keep claims factual and cautious. Do not invent exact metrics, prices, rankings, or guarantees.

SEO metadata requirements:
- "seoTitle": <= 70 characters, includes the tool name.
- "seoDescription": <= 160 characters, compelling and accurate.
- "excerpt": 1-2 sentence summary, <= 300 characters.

Image prompt requirements:
- Return one photorealistic editorial cover image prompt (30-60 words) evoking SEO / analytics / digital marketing.
- No readable text, no logos, no brand names, no UI screenshots, no identifiable faces.`;

  const text = await callAI({
    system:
      'You are a senior SEO editor and subject-matter writer. Return strict JSON only. Never invent facts that require current verification.',
    user: prompt,
    maxTokens: Math.max(Number(maxOutputTokensEnv()) || 0, 16000),
  });
  const post = parseAiJson(text, { providerName: activeProviderName() });
  validatePost(post);
  normalizePostForStrapi(post);
  post.slug = slugifyValue(post.slug || post.title);
  post.content = ensureInternalLinks(post.content, tool);
  post.readingTimeMinutes = Number(post.readingTimeMinutes) || estimateReadingTime(post.content);
  return post;
}

function validatePost(post) {
  const required = ['title', 'excerpt', 'content', 'seoTitle', 'seoDescription'];
  for (const field of required) {
    if (!post?.[field]) throw new Error(`${activeProviderName()} response missing "${field}".`);
  }
}

function normalizePostForStrapi(post) {
  post.title = limitText(post.title, 255);
  post.slug = slugifyValue(post.slug || post.title);
  post.excerpt = limitText(post.excerpt, 500);
  post.seoTitle = limitText(post.seoTitle, 255);
  post.seoDescription = limitText(post.seoDescription, 320);
}

// Guarantee the primary internal links exist even if the model omitted them.
function ensureInternalLinks(content, tool) {
  let out = String(content || '').trim();
  const hasToolLink = out.includes(`/${tool.slug}`);
  const hasResourcesLink = out.includes('/resources');

  if (!hasToolLink || !hasResourcesLink) {
    const parts = [];
    if (!hasToolLink) {
      parts.push(`Try the free [${tool.name}](${toolPageUrl(tool.slug)}) on fxnSEOTools.`);
    }
    if (!hasResourcesLink) {
      parts.push(`Explore [more SEO resources](${RESOURCES_URL}).`);
    }
    out += `\n\n## Get started\n\n${parts.join(' ')}`;
  }
  return out;
}

function limitText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength).replace(/[,\s;:.-]+$/, '');
  const lastSpace = clipped.lastIndexOf(' ');
  const shortened = lastSpace >= Math.floor(maxLength * 0.7) ? clipped.slice(0, lastSpace) : clipped;
  return shortened.replace(/\s+(and|or|to|for|with|of|in|on|at|by)$/i, '').trim();
}

// ---------------------------------------------------------------------------
// Images (Fal.ai FLUX)
// ---------------------------------------------------------------------------

function publicMediaBase() {
  return (STRAPI_PUBLIC_URL || STRAPI_URL || '').replace(/\/$/, '');
}

async function generateImage(prompt, { aspect = 'landscape_16_9' } = {}) {
  const modelId = FAL_MODEL_IDS[argv['image-model']] || FAL_MODEL_IDS.schnell;
  const result = await fal.subscribe(modelId, {
    input: { prompt, image_size: aspect, num_images: 1, enable_safety_checker: true },
    logs: false,
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error(`Fal.ai returned no image URL for prompt: ${prompt.slice(0, 80)}...`);
  return url;
}

async function uploadImageToStrapi(imageUrl, filename) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image ${imageUrl}: ${res.status}`);
  const ab = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const name = `${filename}.${ext}`;

  const form = new FormData();
  form.append('files', new Blob([ab], { type: contentType }), name);

  const uploadRes = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    body: form,
  });
  if (!uploadRes.ok) {
    const detail = await uploadRes.text();
    throw new Error(`Strapi upload failed ${uploadRes.status}: ${detail.slice(0, 300)}`);
  }
  const uploaded = await uploadRes.json();
  const media = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  const id = media?.id;
  if (!id) throw new Error('Strapi upload returned no media id.');
  const rel = media?.url || '';
  const url = rel && !/^https?:\/\//i.test(rel) ? `${publicMediaBase()}/${rel.replace(/^\//, '')}` : rel;
  return { id, url };
}

async function generateCoverImage(post) {
  const coverPrompt = post?.imagePrompts?.cover;
  if (!coverPrompt) {
    console.log(`  (no cover image prompt returned by ${activeProviderName()} - skipping image)`);
    return { id: null, url: null };
  }
  const baseName = slugifyValue(post.title || 'fxnseo-post').slice(0, 50);
  process.stdout.write(`  generating cover image with Fal.ai FLUX [${argv['image-model']}]... `);
  const t0 = Date.now();
  const imgUrl = await generateImage(coverPrompt, { aspect: 'landscape_16_9' });
  const media = await uploadImageToStrapi(imgUrl, `${baseName}-cover`);
  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  return media; // { id, url }
}

// ---------------------------------------------------------------------------
// Save to Strapi (minimal fxnseo-post payload)
// ---------------------------------------------------------------------------

async function postToStrapi(post, { coverId } = {}) {
  const data = {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    content: post.content,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
  };
  if (coverId) data.coverImage = coverId;
  if (argv.publish) data.publishedAt = new Date().toISOString();

  return strapi(SITE.postEndpoint, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

// ---------------------------------------------------------------------------
// Save to SumoSEO native blog (pages + page_translations) via PHP importer
// ---------------------------------------------------------------------------

async function saveToSumoSEO(post, coverUrl, opts = {}) {
  if (!fs.existsSync(SUMOSEO_IMPORTER)) {
    throw new Error(`SumoSEO importer not found at ${SUMOSEO_IMPORTER}`);
  }

  const publish = opts.publish !== undefined ? opts.publish : !!argv.publish;
  const payload = {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    content: post.content, // markdown; the PHP importer converts to HTML
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    featured_image: coverUrl || null,
    publish,
    skip_if_exists: !!opts.skipIfExists,
  };

  // World-readable temp file so the www-data importer process can read it.
  const tmp = path.join(os.tmpdir(), `fxnseo-native-${slugifyValue(post.slug).slice(0, 40)}-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.chmodSync(tmp, 0o644);

  try {
    // sudo -u www-data php <importer> <json>  (keeps framework cache files www-data-owned)
    const { stdout } = await execFileAsync(
      'sudo',
      ['-u', SUMOSEO_RUN_AS, 'php', SUMOSEO_IMPORTER, tmp],
      { cwd: SUMOSEO_APP_DIR, maxBuffer: 1024 * 1024 },
    );
    const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
    const result = JSON.parse(line);
    if (result.error) throw new Error(result.error);
    return result; // { id, slug }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Add-images mode: backfill cover images for articles missing one
// ---------------------------------------------------------------------------

function coverPromptForTitle(title) {
  return `Photorealistic editorial hero image evoking SEO, search, and digital marketing for an article titled "${title}". A clean modern workspace with a laptop showing abstract analytics dashboards, charts, and data graphs; subtle magnifier / search and connection motifs; soft natural lighting; shallow depth of field; professional color grade. No readable text, no logos, no watermarks, no identifiable faces.`;
}

// Update an existing native (SumoSEO) post's featured_image by slug.
async function setNativeFeaturedImage(slug, url) {
  const payload = { slug, featured_image: url, set_featured_image_only: true };
  const tmp = path.join(os.tmpdir(), `fxnseo-img-${slugifyValue(slug).slice(0, 40)}-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.chmodSync(tmp, 0o644);
  try {
    const { stdout } = await execFileAsync(
      'sudo',
      ['-u', SUMOSEO_RUN_AS, 'php', SUMOSEO_IMPORTER, tmp],
      { cwd: SUMOSEO_APP_DIR, maxBuffer: 1024 * 1024 },
    );
    const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
    const result = JSON.parse(line);
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function addMissingImages() {
  if (!FAL_KEY) fatal('FAL_KEY is not set in .env. Get one at https://fal.ai/dashboard/keys');

  console.log(`${SITE.label} - generate cover images for articles missing one\n`);
  const records = await fetchStrapiPostsFull();
  const missing = records.filter((r) => !r.coverUrl && r.slug && r.title);
  if (!missing.length) {
    console.log('All articles already have a cover image. Nothing to do.');
    return;
  }
  console.log(`${missing.length} article(s) missing a cover image.\n`);

  let done = 0;
  let failed = 0;
  for (const rec of missing) {
    try {
      process.stdout.write(`[${rec.slug}] generating image [${argv['image-model']}]... `);
      const imgUrl = await generateImage(coverPromptForTitle(rec.title), { aspect: 'landscape_16_9' });
      const media = await uploadImageToStrapi(imgUrl, `${slugifyValue(rec.title).slice(0, 50)}-cover`);
      process.stdout.write('uploaded\n');

      // Attach to Strapi (by documentId)
      if (rec.documentId) {
        await strapi(`${SITE.postEndpoint}/${rec.documentId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: { coverImage: media.id } }),
        });
        console.log(`  strapi coverImage set (media=${media.id})`);
      }

      // Attach to native post (featured_image), if it exists
      try {
        const nat = await setNativeFeaturedImage(rec.slug, media.url);
        if (nat.updated_image) console.log(`  native featured_image set (page #${nat.id})`);
      } catch (e) {
        console.log(`  native update skipped: ${e.message.slice(0, 120)}`);
      }
      done += 1;
    } catch (error) {
      process.stdout.write('\n');
      console.log(`  failed: ${error.message.slice(0, 160)}`);
      failed += 1;
    }
  }
  console.log(`\nDone. images added=${done} · failed=${failed}`);
}

// ---------------------------------------------------------------------------
// Import mode: backfill Strapi articles into the SumoSEO native blog
// ---------------------------------------------------------------------------

async function fetchStrapiPostsFull() {
  const byId = new Map();
  for (const status of ['published', 'draft']) {
    let page = 1;
    for (;;) {
      const res = await strapi(
        `${SITE.postEndpoint}?populate=coverImage&pagination[page]=${page}&pagination[pageSize]=100&status=${status}`,
      );
      const data = res?.data || [];
      for (const it of data) {
        const id = it.documentId || it.id;
        if (!id || byId.has(id)) continue;
        const rel = it.coverImage?.url || '';
        const coverUrl = rel
          ? (/^https?:\/\//i.test(rel) ? rel : `${publicMediaBase()}/${rel.replace(/^\//, '')}`)
          : null;
        byId.set(id, {
          documentId: it.documentId || null,
          title: it.title,
          slug: it.slug,
          excerpt: it.excerpt || '',
          content: it.content || '',
          seoTitle: it.seoTitle || it.title,
          seoDescription: it.seoDescription || '',
          published: !!it.publishedAt,
          coverUrl,
        });
      }
      const pageCount = res?.meta?.pagination?.pageCount || 1;
      if (page >= pageCount) break;
      page += 1;
    }
  }
  return [...byId.values()];
}

async function importFromStrapi() {
  console.log(`${SITE.label} - import Strapi articles into the native /blog\n`);
  const records = await fetchStrapiPostsFull();
  if (!records.length) {
    console.log('No Strapi posts found.');
    return;
  }
  console.log(`Found ${records.length} Strapi post(s).\n`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (const rec of records) {
    if (!rec.slug || !rec.title) {
      console.log(`  skip (incomplete): ${rec.slug || '(no slug)'}`);
      skipped += 1;
      continue;
    }
    try {
      const res = await saveToSumoSEO(rec, rec.coverUrl, { publish: rec.published, skipIfExists: true });
      if (res.skipped) {
        console.log(`  skip (already in blog): ${res.slug}`);
        skipped += 1;
      } else {
        console.log(`  imported #${res.id} [${rec.published ? 'published' : 'draft'}]: ${res.slug}`);
        imported += 1;
      }
    } catch (error) {
      console.log(`  failed ${rec.slug}: ${error.message.slice(0, 160)}`);
      failed += 1;
    }
  }
  console.log(`\nDone. imported=${imported} · skipped=${skipped} · failed=${failed}`);
  if (imported) console.log(`Review at ${SITE.siteUrl}/admin/posts and ${SITE.siteUrl}/blog`);
}

// ---------------------------------------------------------------------------
// Delete mode
// ---------------------------------------------------------------------------

async function fetchAllPosts() {
  const byId = new Map();
  for (const status of ['published', 'draft']) {
    let page = 1;
    for (;;) {
      const res = await strapi(
        `${SITE.postEndpoint}?fields[0]=title&fields[1]=slug&fields[2]=publishedAt&pagination[page]=${page}&pagination[pageSize]=100&status=${status}`,
      );
      const data = res?.data || [];
      for (const item of data) {
        const id = item.documentId || item.id;
        if (id && !byId.has(id)) {
          byId.set(id, { id, title: item.title, slug: item.slug, published: !!item.publishedAt });
        }
      }
      const pageCount = res?.meta?.pagination?.pageCount || 1;
      if (page >= pageCount) break;
      page += 1;
    }
  }
  return [...byId.values()];
}

async function runDeleteFlow() {
  console.log(`${SITE.label} - delete posts\n`);
  const posts = await fetchAllPosts();
  if (!posts.length) {
    console.log('No posts found.');
    return;
  }
  const picked = await checkbox({
    message: 'Select posts to DELETE (space to toggle, enter to confirm):',
    choices: posts.map((p) => ({
      name: `${p.title || '(untitled)'} (${p.slug})${p.published ? '' : ' [draft]'}`,
      value: p.id,
    })),
    pageSize: 20,
  });
  if (!picked.length) {
    console.log('Nothing selected - no posts deleted.');
    return;
  }
  let deleted = 0;
  for (const id of picked) {
    try {
      await strapi(`${SITE.postEndpoint}/${id}`, { method: 'DELETE' });
      console.log(`  deleted: ${id}`);
      deleted += 1;
    } catch (error) {
      console.log(`  failed to delete ${id}: ${error.message.slice(0, 140)}`);
    }
  }
  console.log(`\nDone. Deleted ${deleted}/${picked.length} post(s).`);
}

// ---------------------------------------------------------------------------
// AI plumbing + utilities
// ---------------------------------------------------------------------------

async function callAI({ system, user, maxTokens }) {
  if (aiProvider === 'openai') {
    const response = await openaiClient.responses.create({
      model: OPENAI_MODEL,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
    });
    return response.output_text?.trim() || '';
  }

  if (aiProvider === 'openrouter') {
    const completion = await openrouterClient.chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      extra_headers: {
        'HTTP-Referer': OPENROUTER_SITE_URL,
        'X-OpenRouter-Title': OPENROUTER_APP_NAME,
      },
    });
    return completion.choices?.[0]?.message?.content?.trim() || '';
  }

  const msg = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return msg.content.map((block) => (block.type === 'text' ? block.text : '')).join('').trim();
}

function lengthWasProvided() {
  return process.argv.some(
    (arg) => arg === '--length' || arg.startsWith('--length=') || arg === '-l' || /^-l[^-]/.test(arg),
  );
}

function resolveArticleLengthConfig() {
  return ARTICLE_LENGTH_TARGETS[argv.length] || ARTICLE_LENGTH_TARGETS.long;
}

function articleLengthLabel() {
  return resolveArticleLengthConfig().label;
}

function slugifyValue(value) {
  return slugify(String(value || ''), { lower: true, strict: true, trim: true });
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function estimateReadingTime(markdown) {
  const words = wordCount(markdown);
  return Math.max(1, Math.ceil(words / 220));
}

function wordCount(content) {
  return String(content || '')
    .replace(/<[^>]*>/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function activeModel() {
  if (aiProvider === 'openai') return OPENAI_MODEL;
  if (aiProvider === 'openrouter') return OPENROUTER_MODEL;
  return CLAUDE_MODEL;
}

function activeProviderName() {
  if (aiProvider === 'openai') return 'OpenAI';
  if (aiProvider === 'openrouter') return 'OpenRouter';
  return 'Claude';
}

function maxOutputTokensEnv() {
  if (aiProvider === 'openai') return OPENAI_MAX_OUTPUT_TOKENS;
  if (aiProvider === 'openrouter') return OPENROUTER_MAX_TOKENS;
  return CLAUDE_MAX_TOKENS;
}

function fatal(message) {
  console.error('✖', message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  if (argv.delete) {
    await runDeleteFlow();
    return;
  }

  if (argv['import-strapi']) {
    await importFromStrapi();
    return;
  }

  if (argv['add-images']) {
    await addMissingImages();
    return;
  }

  await promptForMissingOptions();
  const tool = toolBySlug(argv.tool);

  console.log(`${SITE.label} post generator`);
  console.log(`Tool: ${tool.name} (${tool.slug})`);
  console.log(
    `AI: ${aiProvider} | Model: ${activeModel()} | length: ${articleLengthLabel()} | dry-run: ${argv['dry-run']} | publish: ${argv.publish} | images: ${argv.images}\n`,
  );

  const jobs = await buildJobs();
  console.log(`Queue: ${jobs.length} post(s)\n`);

  const results = [];
  for (const [index, job] of jobs.entries()) {
    console.log(`[${index + 1}/${jobs.length}] Generating: ${job.topic}`);

    const related = await fetchRelatedPosts(slugifyValue(job.topic));
    const post = await generatePost(job.topic, job.tool, related);

    if (argv['dry-run']) {
      console.log(JSON.stringify({ tool: job.tool.slug, data: post }, null, 2));
      results.push({ topic: job.topic, slug: post.slug, status: 'dry-run' });
      continue;
    }

    let cover = { id: null, url: null };
    if (argv.images) {
      try {
        cover = await generateCoverImage(post);
      } catch (error) {
        console.log(`  image step failed (${error.message.slice(0, 140)}) - saving post without image`);
      }
    }

    const doStrapi = argv.target === 'both' || argv.target === 'strapi';
    const doNative = argv.target === 'both' || argv.target === 'native';
    const statusLabel = argv.publish ? 'published' : 'draft';

    if (doStrapi) {
      const saved = await postToStrapi(post, { coverId: cover.id });
      const sid = saved?.data?.documentId || saved?.data?.id;
      console.log(`  strapi ${statusLabel}: ${post.slug}${cover.id ? ` · cover=${cover.id}` : ''}`);
      if (argv.publish) console.log(`    live: ${SITE.siteUrl}/resources/${post.slug}`);
      console.log(`    review: ${STRAPI_URL}/admin/content-manager/collection-types/${SITE.adminUid}/${sid}`);
    }

    if (doNative) {
      try {
        const native = await saveToSumoSEO(post, cover.url);
        console.log(`  native ${statusLabel} (SumoSEO) post #${native.id}: ${native.slug}`);
        if (argv.publish) console.log(`    live: ${SITE.siteUrl}/blog/${native.slug}`);
        console.log(`    admin: ${SITE.siteUrl}/admin/posts`);
      } catch (error) {
        console.log(`  native import failed: ${error.message.slice(0, 200)}`);
      }
    }

    console.log('');
    results.push({ topic: job.topic, slug: post.slug, status: statusLabel });
  }

  console.log('Done.');
  for (const result of results) {
    console.log(`- ${result.status}: ${result.slug}`);
  }
}

run().catch((error) => fatal(error.message));
