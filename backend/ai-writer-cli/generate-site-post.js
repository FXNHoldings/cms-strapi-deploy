#!/usr/bin/env node
// Generate blog posts for the site-specific Strapi collections:
// nxt.bargains, bestlooking.skin, and nxtsmart.homes.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fal } from '@fal-ai/client';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { input, select } from '@inquirer/prompts';

const SITE_CONFIG = {
  'nxt.bargains': {
    label: 'NXT.Bargains',
    postEndpoint: '/api/nxt-posts',
    categoryEndpoint: '/api/nxt-categories',
    adminUid: 'api::nxt-post.nxt-post',
    defaultPostType: 'product-comparison',
    defaultCategories: [
      'product-comparisons',
      'product-reviews',
      'product-roundups',
      'buying-guides',
      'how-to-guides',
      'top-rated-smart-electronics-devices',
      'nxt-bargains-informative-articles',
      'smart-home',
      'best-sellers-articles',
    ],
    editorialBrief:
      'Write practical shopping content for NXT.Bargains. Focus on product comparisons, roundups, value, specs, tradeoffs, and buyer intent. Avoid fake prices, fake availability, and unsupported claims.',
    topicNiche: 'consumer products, ecommerce bargains, shopping guides, product reviews',
  },
  'bestlooking.skin': {
    label: 'BestLooking.Skin',
    postEndpoint: '/api/bls-posts',
    categoryEndpoint: '/api/bls-categories',
    adminUid: 'api::bls-post.bls-post',
    defaultPostType: 'product-review',
    defaultCategories: [
      'skincare-reviews',
      'product-comparisons',
      'product-roundups',
      'how-to-guides',
      'top-rated',
    ],
    editorialBrief:
      'Write careful skincare content for BestLooking.Skin. Focus on routines, ingredients, comparisons, product reviews, skin types, and practical guidance. Do not make medical claims or promise results.',
    topicNiche: 'skincare, beauty products, routines, ingredients, product reviews',
  },
  'nxtsmart.homes': {
    label: 'NXTSmart.Homes',
    postEndpoint: '/api/nxtsmart-posts',
    categoryEndpoint: '/api/nxtsmart-categories',
    adminUid: 'api::nxtsmart-post.nxtsmart-post',
    defaultPostType: 'informative',
    defaultCategories: [
      'smart-home-automation',
      'smart-home-security',
      'smart-home-devices',
      'smart-home-entertainment',
      'smart-home-energy',
      'smart-home-integration',
      'how-to-guides',
      'product-reviews',
    ],
    editorialBrief:
      'Write useful smart home content for NXTSmart.Homes. Focus on setup, compatibility, security, automation, device comparisons, reliability, and homeowner-friendly explanations.',
    topicNiche: 'smart home devices, home automation, security, energy, entertainment, integrations',
  },
};

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [--site <site>] [topic] [options]')
  .option('site', {
    alias: 's',
    type: 'string',
    choices: Object.keys(SITE_CONFIG),
    describe: 'Target site collection. Prompts when omitted.',
  })
  .option('topic', { alias: 't', type: 'string', describe: 'Single article topic/title' })
  .option('topics', {
    type: 'string',
    describe: 'Topic file. Lines may be "category | topic" or "site | category | topic".',
  })
  .option('category', { alias: 'c', type: 'string', describe: 'Category slug or name' })
  .option('count', {
    alias: 'n',
    type: 'number',
    describe: 'How many articles to brainstorm for --category, or cap topic-file rows',
  })
  .option('tone', {
    type: 'string',
    default: 'helpful',
    choices: ['helpful', 'professional', 'friendly', 'witty', 'luxury'],
  })
  .option('length', {
    alias: 'l',
    type: 'string',
    default: 'long',
    choices: ['short', 'medium', 'long'],
  })
  .option('post-type', {
    type: 'string',
    describe: 'Override postType. Defaults to a good value for the selected site.',
  })
  .option('keywords', { alias: 'k', type: 'string', describe: 'Comma-separated SEO keywords' })
  .option('amazon-tag', { type: 'string', describe: 'amazonAffiliateTag value for the post' })
  .option('language', { type: 'string', default: 'English' })
  .option('publish', { type: 'boolean', default: false, describe: 'Publish immediately; default is draft' })
  .option('images', {
    type: 'boolean',
    describe: 'Generate 1 cover + 2 gallery images with Fal.ai. Use --no-images to skip.',
  })
  .option('image-model', {
    type: 'string',
    default: 'schnell',
    choices: ['schnell', 'dev', 'pro'],
    describe: 'Fal.ai FLUX variant',
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
  OPENROUTER_SITE_URL = 'https://cms.fxnstudio.com',
  OPENROUTER_APP_NAME = 'FXN AI Writer CLI',
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-5-20250929',
  CLAUDE_MAX_TOKENS = '4096',
  STRAPI_URL,
  STRAPI_API_TOKEN,
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

const NXT_BARGAINS_BEST_SELLERS_DIR = '/var/www/html/nxt.bargains/data';
const NXT_BARGAINS_DEAL_MARKETPLACES = [
  {
    key: 'amazon',
    label: 'Amazon',
    pageUrl: 'https://nxt.bargains/best-sellers/amazon',
    file: 'best-sellers.json',
  },
  {
    key: 'ebay',
    label: 'eBay',
    pageUrl: 'https://nxt.bargains/best-sellers/ebay',
    file: 'best-sellers-ebay.json',
  },
  {
    key: 'walmart',
    label: 'Walmart',
    pageUrl: 'https://nxt.bargains/best-sellers/walmart',
    file: 'best-sellers-walmart.json',
  },
  {
    key: 'target',
    label: 'Target',
    pageUrl: 'https://nxt.bargains/best-sellers/target',
    file: 'best-sellers-target.json',
  },
  {
    key: 'newegg',
    label: 'Newegg',
    pageUrl: 'https://nxt.bargains/best-sellers/newegg',
    file: 'best-sellers-newegg.json',
  },
];
const NXT_BARGAINS_DEALS_MIN_WORDS = 1000;
const NXT_BARGAINS_SITE_URL = 'https://nxt.bargains';
const NXT_SMART_HOME_CATEGORY = 'smart-home';
const NXT_SMART_HOME_MIN_WORDS = 1000;
const NXT_SMART_HOME_PRODUCT_CAROUSEL_LIMIT = 8;
const NXT_SMART_HOME_PRODUCT_CATEGORIES = [
  {
    slug: 'smart-light-bulbs',
    label: 'Smart Light Bulbs',
    categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smart-light-bulbs`,
  },
  {
    slug: 'smart-plugs',
    label: 'Smart Plugs',
    categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smart-plugs`,
  },
  {
    slug: 'video-doorbells',
    label: 'Smart Doorbells',
    categoryPage: `${NXT_BARGAINS_SITE_URL}/category/video-doorbells`,
  },
  {
    slug: 'smart-door-locks',
    label: 'Smart Door Locks',
    categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smart-door-locks`,
  },
];

let site = null;
const categoryCache = new Map();
let smartHomeProductsCache = null;

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
  return res.json();
}

async function resolveCategoryId(slugOrName) {
  if (!slugOrName) return null;
  const raw = String(slugOrName).trim();
  const slug = slugifyValue(raw);
  const cacheKey = `${argv.site}:${slug}`;
  if (categoryCache.has(cacheKey)) return categoryCache.get(cacheKey);

  const bySlug = await strapi(
    `${site.categoryEndpoint}?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`,
  );
  let category = bySlug?.data?.[0];

  if (!category) {
    const byName = await strapi(
      `${site.categoryEndpoint}?filters[name][$eqi]=${encodeURIComponent(raw)}&pagination[pageSize]=1`,
    );
    category = byName?.data?.[0];
  }

  if (!category) {
    console.log(`  · Category "${raw}" not found for ${site.label} - creating it`);
    const created = await strapi(site.categoryEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          name: titleCase(raw),
          slug,
        },
      }),
    });
    category = created.data;
  }

  const id = category.id;
  categoryCache.set(cacheKey, id);
  return id;
}

async function promptForMissingOptions() {
  if (!argv.site) {
    argv.site = await select({
      message: 'Which site should this post be generated for?',
      choices: Object.entries(SITE_CONFIG).map(([value, config]) => ({
        name: config.label,
        value,
      })),
    });
  }

  site = SITE_CONFIG[argv.site];
  if (!site) fatal(`Unknown site: ${argv.site}`);

  if (!argv.topics && !argv.category) {
    argv.category = await promptForCategory();
  }

  if (!argv.topics && !argv.topic && !argv.count) {
    const mode = await select({
      message: 'What do you want to generate?',
      choices: [
        { name: 'Brainstorm topics and generate posts', value: 'count' },
        { name: 'Write one specific topic', value: 'topic' },
      ],
    });

    if (mode === 'topic') {
      argv.topic = await input({
        message: 'Article topic/title:',
        validate: (value) => String(value).trim() ? true : 'Enter a topic.',
      });
    } else {
      const answer = await input({
        message: 'How many posts should I generate?',
        default: '1',
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
        message: 'Generate cover and gallery images for each post?',
        choices: [
          { name: 'Yes, generate images', value: true },
          { name: 'No, text only', value: false },
        ],
      });
    } else {
      argv.images = true;
    }
  }

  if (argv.images && !argv['dry-run'] && !FAL_KEY) {
    fatal('FAL_KEY is not set in .env. Get one at https://fal.ai/dashboard/keys - or pass --no-images to skip image generation.');
  }
}

async function promptForCategory() {
  const customValue = '__custom__';
  const picked = await select({
    message: `Which ${site.label} category should this use?`,
    choices: [
      ...site.defaultCategories.map((category) => ({
        name: `${titleCase(category)} (${category})`,
        value: category,
      })),
      { name: 'Custom category...', value: customValue },
    ],
  });

  if (picked !== customValue) return picked;

  return input({
    message: 'Category slug or name:',
    validate: (value) => String(value).trim() ? true : 'Enter a category.',
  });
}

async function brainstormTopics(category, count) {
  if (isNxtDealsCategory(category)) {
    const products = pickRandomDealProducts(count);
    return products.map((product) => dealTopicForProduct(product));
  }

  if (isNxtSmartHomeCategory(category)) {
    const products = await pickRandomSmartHomeProducts(count);
    return products.map((product) => smartHomeTopicForProduct(product));
  }

  const prompt = `Brainstorm ${count} strong blog article titles for ${site.label}.

Site niche: ${site.topicNiche}
Category: ${category}
Language: ${argv.language}

Return STRICT JSON only:
{
  "topics": ["title one", "title two"]
}

Rules:
- Make each topic specific and useful.
- Avoid years unless the topic genuinely needs one.
- Avoid duplicate wording.
- Do not include fake prices, fake discounts, or unsupported claims.`;

  const result = await callAI({
    system: 'You are an editorial strategist. Return only valid JSON.',
    user: prompt,
    maxTokens: 1200,
  });
  const parsed = parseJson(result);
  const topics = Array.isArray(parsed?.topics) ? parsed.topics : [];
  if (!topics.length) throw new Error(`${activeProviderName()} did not return any topics.`);
  return topics.slice(0, count);
}

async function generatePost(topic, category, { dealProduct = null, smartHomeProduct = null } = {}) {
  const isDealsPost = isNxtDealsCategory(category);
  const isSmartHomePost = isNxtSmartHomeCategory(category);
  const wordTarget = isDealsPost ? `at least ${NXT_BARGAINS_DEALS_MIN_WORDS}`
    : isSmartHomePost ? `at least ${NXT_SMART_HOME_MIN_WORDS}`
      : {
        short: '650-850',
        medium: '1000-1300',
        long: '1500-2200',
      }[argv.length];

  const dealContext = dealProductPromptContext(dealProduct);
  const smartHomeContext = smartHomeProductPromptContext(smartHomeProduct);
  const contentFormat = isSmartHomePost && smartHomeProduct ? 'HTML' : 'Markdown';

  const prompt = `${site.editorialBrief}

Write one complete blog post.

Topic: ${topic}
Category: ${category || 'General'}
Tone: ${argv.tone}
Length: ${wordTarget} words
Language: ${argv.language}
SEO keywords: ${argv.keywords || 'choose natural keywords from the topic'}
${dealContext}${smartHomeContext}

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
    "cover": string,
    "gallery": [string, string]
  }
}

Content requirements:
- ${contentFormat} only in "content".
- Use useful ${contentFormat === 'HTML' ? 'h2/h3' : 'H2/H3'} headings.
- Include practical comparisons, tips, caveats, and buying/setup guidance where relevant.
- For NXT.Bargains Best Sellers articles, write at least ${NXT_BARGAINS_DEALS_MIN_WORDS} words in "content".
- For NXT.Bargains Best Sellers articles, optimize the title for deal-shopping intent and make it concise, specific, and clickable without sounding spammy.
- For NXT.Bargains Best Sellers articles, make the selected best-seller product the article's main subject and keep the article focused on whether it is a worthwhile deal.
- For NXT.Bargains Best Sellers articles, include why shoppers may want it, where the value is, who should skip it, competing alternatives to compare, and what to check before buying.
- For NXT.Bargains Smart Home articles, write at least ${NXT_SMART_HOME_MIN_WORDS} words in "content".
- For NXT.Bargains Smart Home articles, make the selected smart home product the article's main subject and keep the article focused on setup, compatibility, features, and buyer fit.
- For NXT.Bargains Smart Home articles, include who should consider it, who should skip it, alternatives to compare, and what to verify before buying.
- For NXT.Bargains Smart Home articles, use valid HTML with useful <h2>, <h3>, <p>, <ul>, and <li> tags only. Do not include a product snapshot card, summary box, or product image URL; the script inserts those automatically.
- Keep claims factual and cautious.
- Do not invent exact prices, ratings, availability, certifications, medical outcomes, or specs.
- Only mention prices, ratings, ranks, marketplace names, and URLs that appear in the selected product context.
- Do not include markdown fences.

Image prompt requirements:
- Return one cover image prompt and exactly two gallery image prompts.
- Prompts must describe photorealistic editorial images that match ${site.label}'s niche.
- No readable text, no logos, no brand names, no UI screenshots, no close-up identifiable faces.
- Keep each image prompt 30-60 words and include subject, setting, lighting, composition, and camera style.`;

  const text = await callAI({
    system:
      'You are a senior SEO editor and subject-matter writer. Return strict JSON only. Never invent facts that require current verification.',
    user: prompt,
    maxTokens: Math.max(Number(maxOutputTokensEnv()) || 0, 16000),
  });
  const post = parseJson(text);
  validatePost(post);
  validateDealPost(post, category);
  validateSmartHomePost(post, category);
  normalizePostForStrapi(post);
  post.slug = slugifyValue(post.slug || post.title);
  if (smartHomeProduct) {
    post.content = buildSmartHomePostContent(post.content, smartHomeProduct);
  }
  post.readingTimeMinutes = Number(post.readingTimeMinutes) || estimateReadingTime(post.content);
  return post;
}

function normalizePostForStrapi(post) {
  post.title = limitText(post.title, 255);
  post.slug = slugifyValue(post.slug || post.title);
  post.excerpt = limitText(post.excerpt, 500);
  post.seoTitle = limitText(post.seoTitle, 70);
  post.seoDescription = limitText(post.seoDescription, 160);
  post.seoKeywords = limitText(post.seoKeywords, 255);
}

function limitText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength).replace(/[,\s;:.-]+$/, '');
  const lastSpace = clipped.lastIndexOf(' ');
  const shortened = lastSpace >= Math.floor(maxLength * 0.7) ? clipped.slice(0, lastSpace) : clipped;
  return shortened.replace(/\s+(and|or|to|for|with|of|in|on|at|by)$/i, '').trim();
}

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
  if (!url) throw new Error(`Fal.ai returned no image URL for prompt: ${prompt.slice(0, 80)}...`);
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

async function generateAndUploadImages(post) {
  const prompts = post?.imagePrompts;
  if (!prompts?.cover || !Array.isArray(prompts.gallery) || prompts.gallery.length < 1) {
    console.log(`  (no image prompts returned by ${activeProviderName()} - skipping images)`);
    return { coverId: null, galleryIds: [] };
  }

  const baseName = slugifyValue(post.title || 'site-post').slice(0, 50);
  const galleryPrompts = prompts.gallery.slice(0, 2);
  process.stdout.write(`  generating ${1 + galleryPrompts.length} images with Fal.ai FLUX [${argv['image-model']}]... `);
  const t0 = Date.now();

  const allPrompts = [
    { kind: 'cover', prompt: prompts.cover, aspect: 'landscape_16_9' },
    ...galleryPrompts.map((prompt, index) => ({
      kind: `gallery-${index + 1}`,
      prompt,
      aspect: 'landscape_4_3',
    })),
  ];

  const results = await Promise.all(
    allPrompts.map(async ({ kind, prompt, aspect }) => {
      const url = await generateImage(prompt, { aspect });
      const id = await uploadImageToStrapi(url, `${baseName}-${kind}`);
      return { kind, id };
    }),
  );

  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const coverId = results.find((result) => result.kind === 'cover')?.id ?? null;
  const galleryIds = results.filter((result) => result.kind !== 'cover').map((result) => result.id);
  return { coverId, galleryIds };
}

async function postToStrapi(post, { categoryId, coverId, galleryIds, sourceUrl } = {}) {
  const data = {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    content: post.content,
    postType: argv['post-type'] || site.defaultPostType,
    readingTimeMinutes: post.readingTimeMinutes,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    seoKeywords: post.seoKeywords,
    source: 'ai',
  };

  if (categoryId) data.categories = [categoryId];
  if (coverId) data.coverImage = coverId;
  if (galleryIds?.length) data.gallery = galleryIds;
  if (sourceUrl) data.sourceUrl = sourceUrl;
  if (argv['amazon-tag']) data.amazonAffiliateTag = argv['amazon-tag'];
  if (argv.publish) data.publishedAt = new Date().toISOString();

  return strapi(site.postEndpoint, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

async function readTopicFile(file) {
  const rows = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const jobs = [];
  for (const row of rows) {
    const parts = row.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 2) {
      jobs.push(await enrichJobWithProductSeed({ category: parts[0], topic: parts[1] }));
    } else if (parts.length >= 3) {
      const [rowSite, category, ...topicParts] = parts;
      if (rowSite === argv.site) {
        jobs.push(await enrichJobWithProductSeed({ category, topic: topicParts.join(' | ') }));
      }
    } else {
      jobs.push(await enrichJobWithProductSeed({ category: argv.category, topic: row }));
    }
  }

  return argv.count ? jobs.slice(0, argv.count) : jobs;
}

async function buildJobs() {
  if (argv.topics) return readTopicFile(argv.topics);

  if (argv.topic) {
    return [await enrichJobWithProductSeed({ category: argv.category, topic: argv.topic })];
  }

  if (argv.category && argv.count) {
    if (isNxtDealsCategory(argv.category)) {
      return pickRandomDealProducts(argv.count).map((dealProduct) => ({
        category: argv.category,
        topic: dealTopicForProduct(dealProduct),
        dealProduct,
      }));
    }

    if (isNxtSmartHomeCategory(argv.category)) {
      const products = await pickRandomSmartHomeProducts(argv.count);
      return products.map((smartHomeProduct) => ({
        category: argv.category,
        topic: smartHomeTopicForProduct(smartHomeProduct),
        smartHomeProduct,
      }));
    }

    const topics = await brainstormTopics(argv.category, argv.count);
    return topics.map((topic) => ({ category: argv.category, topic }));
  }

  if (argv.count) {
    const perCategory = Math.max(1, Math.ceil(argv.count / site.defaultCategories.length));
    const jobs = [];
    for (const category of site.defaultCategories) {
      if (isNxtDealsCategory(category)) {
        const dealJobs = pickRandomDealProducts(perCategory).map((dealProduct) => ({
          category,
          topic: dealTopicForProduct(dealProduct),
          dealProduct,
        }));
        jobs.push(...dealJobs);
        if (jobs.length >= argv.count) break;
        continue;
      }

      if (isNxtSmartHomeCategory(category)) {
        const smartHomeJobs = (await pickRandomSmartHomeProducts(perCategory)).map((smartHomeProduct) => ({
          category,
          topic: smartHomeTopicForProduct(smartHomeProduct),
          smartHomeProduct,
        }));
        jobs.push(...smartHomeJobs);
        if (jobs.length >= argv.count) break;
        continue;
      }

      const topics = await brainstormTopics(category, perCategory);
      jobs.push(...topics.map((topic) => ({ category, topic })));
      if (jobs.length >= argv.count) break;
    }
    return jobs.slice(0, argv.count);
  }

  fatal('Provide a topic, --topics file, or --category with --count.');
}

function isNxtDealsCategory(category) {
  if (argv.site !== 'nxt.bargains') return false;
  const slug = slugifyValue(category || '');
  return slug === 'best-sellers-articles' || slug === 'deals' || slug === 'best-deals';
}

function isNxtSmartHomeCategory(category) {
  if (argv.site !== 'nxt.bargains') return false;
  return slugifyValue(category || '') === NXT_SMART_HOME_CATEGORY;
}

async function enrichJobWithProductSeed(job) {
  if (isNxtDealsCategory(job.category) && !job.dealProduct) {
    return {
      ...job,
      dealProduct: pickRandomDealProducts(1)[0],
    };
  }

  if (isNxtSmartHomeCategory(job.category) && !job.smartHomeProduct) {
    const smartHomeProduct = (await pickRandomSmartHomeProducts(1))[0];
    return {
      ...job,
      smartHomeProduct,
      topic: job.topic || smartHomeTopicForProduct(smartHomeProduct),
    };
  }

  return job;
}

function loadNxtBestSellerProducts() {
  const products = [];

  for (const marketplace of NXT_BARGAINS_DEAL_MARKETPLACES) {
    const filePath = path.join(NXT_BARGAINS_BEST_SELLERS_DIR, marketplace.file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      for (const item of items) {
        if (!item?.title) continue;
        products.push({
          marketplace: marketplace.label,
          marketplaceKey: marketplace.key,
          sourcePage: marketplace.pageUrl,
          rank: item.rank ?? null,
          title: String(item.title).trim(),
          price: item.price ?? null,
          priceValue: item.priceValue ?? null,
          rating: item.rating ?? null,
          ratingCount: item.ratingCount ?? null,
          url: item.url ?? null,
        });
      }
    } catch (error) {
      console.warn(`  · Could not read ${marketplace.file}: ${error.message}`);
    }
  }

  return products;
}

function pickRandomDealProducts(count = 1) {
  const products = loadNxtBestSellerProducts();
  if (!products.length) {
    fatal(`No NXT.Bargains best-seller products found in ${NXT_BARGAINS_BEST_SELLERS_DIR}. Refresh best sellers first.`);
  }

  const shuffled = [...products];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled.slice(0, Math.max(1, Number(count) || 1));
}

function dealTopicForProduct(product) {
  const prefix = product.rank ? `#${product.rank} ${product.marketplace} best seller` : `${product.marketplace} best seller`;
  return `${prefix}: Is ${product.title} actually a good deal?`;
}

async function loadNxtSmartHomeProducts() {
  if (smartHomeProductsCache) return smartHomeProductsCache;

  const products = [];
  for (const categoryMeta of NXT_SMART_HOME_PRODUCT_CATEGORIES) {
    let page = 1;
    while (true) {
      const params = new URLSearchParams({
        'pagination[page]': String(page),
        'pagination[pageSize]': '100',
        'filters[productStatus][$eq]': 'active',
        'filters[categories][slug][$eqi]': categoryMeta.slug,
        'populate[categories][fields][0]': 'name',
        'populate[categories][fields][1]': 'slug',
        'populate[brandRef][fields][0]': 'name',
        'sort[0]': 'updatedAt:desc',
      });
      const response = await strapi(`/api/commerce-products?${params.toString()}`);
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows) {
        const normalized = normalizeSmartHomeProduct(row, categoryMeta);
        if (normalized) products.push(normalized);
      }

      const pageCount = response?.meta?.pagination?.pageCount ?? 1;
      if (page >= pageCount || rows.length === 0) break;
      page += 1;
    }
  }

  if (!products.length) {
    fatal('No active NXT.Bargains smart home products found in Smart Light Bulbs, Smart Plugs, Smart Doorbells, or Smart Door Locks.');
  }

  smartHomeProductsCache = products;
  return products;
}

function normalizeSmartHomeProduct(row, categoryMeta) {
  const title = String(row?.name || row?.title || '').trim();
  const slug = String(row?.slug || '').trim();
  if (!title || !slug) return null;

  const categorySlug = row?.categories?.[0]?.slug || categoryMeta.slug;
  const brand = row?.brandRef?.name || row?.brand || row?.specs?.technicalSpecs?.Brand || null;

  return {
    documentId: row.documentId,
    title,
    slug,
    categorySlug,
    categoryLabel: categoryMeta.label,
    categoryPage: categoryMeta.categoryPage,
    shortDescription: String(row?.shortDescription || '').trim(),
    brand: brand ? String(brand).trim() : null,
    imageUrl: absolutizeMediaUrl(row?.specs?.imageUrl || row?.specs?.sourceImageUrl || null),
    sourceUrl: row?.specs?.sourceUrl || row?.specs?.specSourceUrl || null,
    productUrl: `${NXT_BARGAINS_SITE_URL}/${categorySlug}/${slug}`,
  };
}

function absolutizeMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(STRAPI_URL || '').replace(/\/$/, '');
  return base ? `${base}${raw.startsWith('/') ? raw : `/${raw}`}` : raw;
}

async function pickRandomSmartHomeProducts(count = 1) {
  const products = await loadNxtSmartHomeProducts();
  const shuffled = [...products];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, Math.max(1, Number(count) || 1));
}

function smartHomeTopicForProduct(product) {
  return `${product.categoryLabel}: Is ${product.title} worth adding to your smart home setup?`;
}

function smartHomeProductPromptContext(product) {
  if (!product) return '';

  return `

Selected NXT.Bargains smart home product context:
- Product category: ${product.categoryLabel}
- Category page: ${product.categoryPage}
- Product title: ${product.title}
- Brand: ${product.brand ?? 'not listed'}
- Short description: ${product.shortDescription || 'not listed'}
- NXT.Bargains product page: ${product.productUrl}
- Merchant/source URL: ${product.sourceUrl ?? 'not listed'}

Smart Home article requirements:
- Base the article on this selected product from the NXT.Bargains ${product.categoryLabel} catalog.
- Keep the selected product as the main subject throughout the article. Do not drift into a generic category roundup.
- Write at least ${NXT_SMART_HOME_MIN_WORDS} words of article content.
- Focus on setup, compatibility, automation, security, energy, convenience, and buyer fit for smart home shoppers.
- Include who should consider it, who should skip it, alternatives to compare, and what to verify before buying.
- Mention the product category and link naturally to the NXT.Bargains product page when relevant.
- Do not invent exact prices, ratings, certifications, compatibility claims, or specs that are not provided.
- Do not claim the product is objectively the best; explain practical reasons it may or may not fit a smart home setup.`;
}

function buildSmartHomePostContent(html, product) {
  const content = sanitizeGeneratedHtml(html);
  const card = buildSmartHomeProductCard(product);
  return `${card}\n${insertSmartHomeProductCarouselInMiddle(content, product)}`;
}

function sanitizeGeneratedHtml(html) {
  return String(html || '')
    .replace(/^```(?:html|json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function insertSmartHomeProductCarouselInMiddle(html, product) {
  const content = String(html || '').trim();
  const carousel = buildSmartHomeProductCarousel(product);
  if (!carousel) return content;

  const paragraphMatches = [...content.matchAll(/<\/p>/gi)];
  if (!paragraphMatches.length) return `${content}\n${carousel}`;

  const middleParagraph = Math.max(3, Math.floor(paragraphMatches.length / 2));
  const targetMatch = paragraphMatches[Math.min(middleParagraph - 1, paragraphMatches.length - 1)];
  const splitAt = targetMatch.index + targetMatch[0].length;
  return `${content.slice(0, splitAt)}\n${carousel}\n${content.slice(splitAt).trimStart()}`;
}

function buildSmartHomeProductCarousel(product) {
  const siblings = (smartHomeProductsCache || [])
    .filter((item) => item.categorySlug === product.categorySlug && item.slug !== product.slug && item.imageUrl)
    .slice(0, NXT_SMART_HOME_PRODUCT_CAROUSEL_LIMIT);

  if (!siblings.length) return '';

  const cards = siblings.map((item) => `<a class="nxt-product-carousel__item" href="${escapeAttr(item.productUrl)}" target="_blank" rel="noopener">
<span class="nxt-product-carousel__image"><img src="${escapeAttr(item.imageUrl)}" alt="${escapeAttr(item.title)}" loading="lazy" /></span>
<span class="nxt-product-carousel__body">
<span class="nxt-product-carousel__title">${escapeHtml(item.title)}</span>
<span class="nxt-product-carousel__meta">${escapeHtml(item.categoryLabel)}</span>
<span class="nxt-product-carousel__price">View on NXT.Bargains</span>
</span>
</a>`).join('\n');

  return `<section class="nxt-product-carousel" data-autoslide="true" aria-label="More ${escapeAttr(product.categoryLabel)} products">
<h3 class="nxt-product-carousel__heading">More ${escapeHtml(product.categoryLabel)} to compare</h3>
<div class="nxt-product-carousel__track">
${cards}
</div>
<p class="nxt-product-carousel__meta"><a href="${escapeAttr(product.categoryPage)}" target="_blank" rel="noopener">Browse all ${escapeHtml(product.categoryLabel)} on NXT.Bargains</a></p>
</section>`;
}

function buildSmartHomeProductCard(product) {
  const details = [
    `<li><strong>Category:</strong> ${escapeHtml(product.categoryLabel)}</li>`,
    product.brand ? `<li><strong>Brand:</strong> ${escapeHtml(product.brand)}</li>` : '',
    product.shortDescription ? `<li><strong>Summary:</strong> ${escapeHtml(product.shortDescription)}</li>` : '',
    `<li><strong>Category page:</strong> <a href="${escapeAttr(product.categoryPage)}" target="_blank" rel="noopener">NXT.Bargains ${escapeHtml(product.categoryLabel)}</a></li>`,
  ].filter(Boolean).join('\n');

  const ctaUrl = product.sourceUrl || product.productUrl;
  const ctaLabel = product.sourceUrl ? 'View merchant listing' : 'View on NXT.Bargains';

  return `<aside class="nxt-product-card" aria-label="Product snapshot">
${product.imageUrl ? `<a class="nxt-product-card__image" href="${escapeAttr(ctaUrl)}" target="_blank" rel="${product.sourceUrl ? 'nofollow sponsored noopener' : 'noopener'}"><img src="${escapeAttr(product.imageUrl)}" alt="${escapeAttr(product.title)}" loading="lazy" /></a>` : '<div class="nxt-product-card__image" aria-hidden="true"></div>'}
<div class="nxt-product-card__details">
<p class="nxt-product-card__eyebrow">Smart Home Product</p>
<h3>${escapeHtml(product.title)}</h3>
${details ? `<ul>${details}</ul>` : ''}
<a class="nxt-product-card__button" href="${escapeAttr(ctaUrl)}" target="_blank" rel="${product.sourceUrl ? 'nofollow sponsored noopener' : 'noopener'}">${escapeHtml(ctaLabel)}</a>
</div>
</aside>`;
}

function dealProductPromptContext(product) {
  if (!product) return '';

  return `

Selected NXT.Bargains best-seller product context:
- Source best-seller page: ${product.sourcePage}
- Marketplace: ${product.marketplace}
- Best-seller rank: ${product.rank ?? 'not listed'}
- Product title: ${product.title}
- Listed price: ${product.price ?? 'not listed'}
- Rating: ${product.rating ?? 'not listed'}
- Rating count: ${product.ratingCount ?? 'not listed'}
- Product URL: ${product.url ?? 'not listed'}

Best Sellers article requirements:
- Base the article on this selected product from the NXT.Bargains Best Sellers list.
- Write as a shopping/deals analysis for someone deciding whether to click through, wait, or compare alternatives.
- Keep the selected product as the main subject throughout the article. Do not drift into a generic buying guide.
- The final title should be rewritten and optimized for deal intent, using the product type, marketplace, and deal angle instead of copying the raw product title.
- Write at least ${NXT_BARGAINS_DEALS_MIN_WORDS} words of article content.
- Explain the deal angle: why it appeared on a best-seller list, what value shoppers might see, what hidden tradeoffs could reduce the value, and what price/condition/shipping checks matter before buying.
- Include the marketplace and source best-seller page.
- Discuss what to verify before buying: final price, shipping, seller, return policy, condition, warranty, compatibility, and current availability.
- Do not claim the product is objectively the best; explain practical reasons it may or may not be a good deal.`;
}

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

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${activeProviderName()} did not return JSON.`);
    return JSON.parse(match[0]);
  }
}

function validatePost(post) {
  const required = ['title', 'excerpt', 'content', 'seoTitle', 'seoDescription', 'seoKeywords'];
  for (const field of required) {
    if (!post?.[field]) throw new Error(`${activeProviderName()} response missing "${field}".`);
  }
}

function validateDealPost(post, category) {
  if (!isNxtDealsCategory(category)) return;
  const words = wordCount(post.content);
  if (words < NXT_BARGAINS_DEALS_MIN_WORDS) {
    throw new Error(
      `${activeProviderName()} returned a Best Sellers article with ${words} words; minimum is ${NXT_BARGAINS_DEALS_MIN_WORDS}. Run again or increase max tokens.`,
    );
  }
}

function validateSmartHomePost(post, category) {
  if (!isNxtSmartHomeCategory(category)) return;
  const words = wordCount(post.content);
  if (words < NXT_SMART_HOME_MIN_WORDS) {
    throw new Error(
      `${activeProviderName()} returned a Smart Home article with ${words} words; minimum is ${NXT_SMART_HOME_MIN_WORDS}. Run again or increase max tokens.`,
    );
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
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

function fatal(message) {
  console.error('✖', message);
  process.exit(1);
}

async function run() {
  await promptForMissingOptions();

  console.log(`${site.label} site-post generator`);
  console.log(`AI: ${aiProvider} | Model: ${activeModel()} | dry-run: ${argv['dry-run']} | publish: ${argv.publish} | images: ${argv.images}\n`);

  const jobs = await buildJobs();
  console.log(`Queue: ${jobs.length} post(s)\n`);

  const results = [];
  for (const [index, job] of jobs.entries()) {
    console.log(`[${index + 1}/${jobs.length}] Generating: ${job.topic}`);
    if (job.dealProduct) {
      console.log(`  best-seller seed: ${job.dealProduct.marketplace} #${job.dealProduct.rank ?? '?'} · ${job.dealProduct.title}`);
    }
    if (job.smartHomeProduct) {
      console.log(`  smart-home seed: ${job.smartHomeProduct.categoryLabel} · ${job.smartHomeProduct.title}`);
    }
    const post = await generatePost(job.topic, job.category, {
      dealProduct: job.dealProduct,
      smartHomeProduct: job.smartHomeProduct,
    });
    const categoryId = argv['dry-run'] ? null : await resolveCategoryId(job.category);

    if (argv['dry-run']) {
      console.log(JSON.stringify({
        site: argv.site,
        category: job.category,
        dealProduct: job.dealProduct ?? null,
        smartHomeProduct: job.smartHomeProduct ?? null,
        data: post,
      }, null, 2));
      results.push({ topic: job.topic, slug: post.slug, status: 'dry-run' });
      continue;
    }

    let coverId = null;
    let galleryIds = [];
    if (argv.images) {
      try {
        if (job.smartHomeProduct?.imageUrl) {
          coverId = await uploadImageToStrapi(
            job.smartHomeProduct.imageUrl,
            slugifyValue(post.title).slice(0, 60),
          );
        } else {
          ({ coverId, galleryIds } = await generateAndUploadImages(post));
        }
      } catch (error) {
        console.log(`  image step failed (${error.message.slice(0, 140)}) - saving post without images`);
      }
    }

    const saved = await postToStrapi(post, {
      categoryId,
      coverId,
      galleryIds,
      sourceUrl: job.smartHomeProduct?.productUrl || job.dealProduct?.url || null,
    });
    const id = saved?.data?.documentId || saved?.data?.id;
    const adminUrl = `${STRAPI_URL}/admin/content-manager/collection-types/${site.adminUid}/${id}`;
    console.log(`  saved ${argv.publish ? 'published' : 'draft'}: ${post.slug}${coverId ? ` · cover=${coverId}` : ''}${galleryIds.length ? ` · gallery=[${galleryIds.join(',')}]` : ''}`);
    console.log(`  review: ${adminUrl}\n`);
    results.push({ topic: job.topic, slug: post.slug, id, status: argv.publish ? 'published' : 'draft' });
  }

  console.log('Done.');
  for (const result of results) {
    console.log(`- ${result.status}: ${result.slug}`);
  }
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

run().catch((error) => fatal(error.message));
