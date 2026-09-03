#!/usr/bin/env node
// Generate blog posts for the site-specific Strapi collections:
// nxt.bargains, bestlooking.skin, nxtsmart.homes, and the WordPress-backed
// Flightfares.one / GlobalScholar.one collections.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fal } from '@fal-ai/client';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { marked } from 'marked';
import { input, select } from '@inquirer/prompts';
import { PROMPT_STYLES, PROMPT_STYLE_KEYS, EDITORIAL_NOTES_SCHEMA } from './prompt-styles.js';
import { parseAiJson } from './parse-ai-json.js';

const SITE_CONFIG = {
  'nxt.bargains': {
    label: 'NXT.Bargains',
    postEndpoint: '/api/nxt-posts',
    categoryEndpoint: '/api/nxt-categories',
    adminUid: 'api::nxt-post.nxt-post',
    publicMediaUrl: 'https://nxt.bargains',
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
    publicMediaUrl: 'https://bestlooking.skin',
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
    publicMediaUrl: 'https://nxtsmart.homes',
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
  'flightfares.one': {
    label: 'Flightfares.one',
    postEndpoint: '/api/flightfares-posts',
    categoryEndpoint: '/api/flightfares-categories',
    adminUid: 'api::flightfares-post.flightfares-post',
    publicMediaUrl: 'https://flightfares.one',
    defaultPostType: null,
    defaultCategories: ['flights', 'destinations', 'planning', 'travel-tips', 'budget-travel'],
    contentFormat: 'HTML',
    simplePost: true,
    editorialBrief:
      'Write practical airfare and flight-planning content for Flightfares.one. Focus on finding fares, booking timing, airports, routes, airline tradeoffs, fees, and realistic travel planning. Never invent live fares, schedules, availability, or airline policies.',
    topicNiche: 'airfares, flight booking, airlines, airports, routes, and practical travel planning',
  },
  'globalscholar.one': {
    label: 'GlobalScholar.one',
    postEndpoint: '/api/globalscholar-posts',
    categoryEndpoint: '/api/globalscholar-categories',
    adminUid: 'api::globalscholar-post.globalscholar-post',
    publicMediaUrl: 'https://globalscholar.one',
    defaultPostType: null,
    defaultCategories: ['scholarships', 'study-abroad', 'applications', 'student-finance', 'international-students'],
    contentFormat: 'HTML',
    simplePost: true,
    editorialBrief:
      'Write careful, actionable education and scholarship content for GlobalScholar.one. Focus on eligibility, application planning, study-abroad decisions, funding, deadlines, and student outcomes. Never invent scholarships, deadlines, award amounts, admission requirements, or visa rules.',
    topicNiche: 'scholarships, international education, study abroad, applications, and student funding',
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
  .option('prompt-style', {
    type: 'string',
    choices: PROMPT_STYLE_KEYS,
    default: 'default',
    describe: 'Article writing method. See prompt-styles.js.',
  })
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
    choices: ['short', 'medium', 'long'],
    describe: 'Article length target. Prompts when omitted in an interactive terminal.',
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
  STRAPI_PUBLIC_URL,
  NEXT_PUBLIC_STRAPI_URL,
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
const NXT_BARGAINS_SITE_URL = 'https://nxt.bargains';
const NXT_SMART_HOME_CATEGORY = 'smart-home';
const ARTICLE_LENGTH_TARGETS = {
  short: {
    label: 'Short',
    words: '700-900',
    dealsMin: 800,
    smartHomeMin: 800,
  },
  medium: {
    label: 'Medium',
    words: '1000-1300',
    dealsMin: 1000,
    smartHomeMin: 1000,
  },
  long: {
    label: 'Long',
    words: '1500-2200',
    dealsMin: 1400,
    smartHomeMin: 1400,
  },
  'very-long': {
    label: 'Very long',
    words: '2200-3000',
    dealsMin: 1800,
    smartHomeMin: 1800,
  },
};
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
const NXT_CORE_ELECTRONICS_CATEGORIES = [
  { slug: 'smart-phones', label: 'Smart Phones', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smart-phones` },
  { slug: 'smartwatches', label: 'Smartwatches', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smartwatches` },
  { slug: 'tablets', label: 'Tablets', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/tablets` },
  { slug: 'laptops', label: 'Laptops', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/laptops` },
  { slug: 'smart-tvs', label: 'Smart TVs', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smart-tvs` },
  { slug: 'smart-cameras', label: 'Smart Cameras', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smart-cameras` },
  { slug: 'smart-speakers', label: 'Smart Speakers', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/smart-speakers` },
  { slug: 'headphones', label: 'Headphones', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/headphones` },
  { slug: 'raspberry-pi', label: 'Raspberry PI', categoryPage: `${NXT_BARGAINS_SITE_URL}/category/raspberry-pi` },
];
const NXT_COMMERCE_CATEGORIES = [...NXT_CORE_ELECTRONICS_CATEGORIES, ...NXT_SMART_HOME_PRODUCT_CATEGORIES];
const NXT_COMMERCE_CATEGORY_BY_SLUG = Object.fromEntries(
  NXT_COMMERCE_CATEGORIES.map((category) => [category.slug, category]),
);
const NXT_CORE_ELECTRONICS_SLUGS = NXT_CORE_ELECTRONICS_CATEGORIES.map((category) => category.slug);
const NXT_SMART_HOME_COMMERCE_SLUGS = NXT_SMART_HOME_PRODUCT_CATEGORIES.map((category) => category.slug);
const NXT_ALL_COMMERCE_SLUGS = NXT_COMMERCE_CATEGORIES.map((category) => category.slug);
const NXT_EDITORIAL_COMMERCE_MAP = {
  'product-comparisons': NXT_CORE_ELECTRONICS_SLUGS,
  'product-reviews': NXT_ALL_COMMERCE_SLUGS,
  'product-roundups': NXT_ALL_COMMERCE_SLUGS,
  'buying-guides': NXT_ALL_COMMERCE_SLUGS,
  'how-to-guides': [...NXT_SMART_HOME_COMMERCE_SLUGS, 'smart-phones', 'laptops', 'tablets', 'smart-tvs', 'smart-speakers'],
  'top-rated-smart-electronics-devices': NXT_CORE_ELECTRONICS_SLUGS,
  'nxt-bargains-informative-articles': NXT_ALL_COMMERCE_SLUGS,
  'smart-home': NXT_SMART_HOME_COMMERCE_SLUGS,
};

let site = null;
const categoryCache = new Map();
const commerceProductsCache = {
  byCategorySlug: new Map(),
  all: [],
};

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

function lengthWasProvided() {
  return process.argv.some((arg) => arg === '--length' || arg.startsWith('--length=') || arg === '-l' || /^-l[^-]/.test(arg));
}

function resolveArticleLengthConfig() {
  return ARTICLE_LENGTH_TARGETS[argv.length] || ARTICLE_LENGTH_TARGETS.long;
}

function articleLengthLabel() {
  return resolveArticleLengthConfig().label;
}

function categoryUrlSlug(category) {
  return slugifyValue(category || "uncategorized") || "uncategorized";
}

async function loadInternalLinkCandidates(category, limit = 8) {
  if (!site || argv["dry-run"] || !category) return [];
  const slug = categoryUrlSlug(category);
  const params = new URLSearchParams({
    "pagination[page]": "1",
    "pagination[pageSize]": String(limit),
    "sort[0]": "publishedAt:desc",
    "fields[0]": "title",
    "fields[1]": "slug",
    "filters[categories][slug][$eqi]": slug,
  });
  try {
    const res = await strapi(`${site.postEndpoint}?${params.toString()}`);
    return (res.data || [])
      .map((post) => ({
        title: String(post.title || "").trim(),
        url: site.simplePost
          ? `${site.publicMediaUrl}/${post.slug}/`
          : `${site.publicMediaUrl}/${slug}/${post.slug}`,
      }))
      .filter((post) => post.title && post.url);
  } catch (error) {
    console.warn(`  · Could not load internal link candidates for ${slug}: ${error.message.slice(0, 120)}`);
    return [];
  }
}

async function buildInternalLinkContext(category) {
  const candidates = await loadInternalLinkCandidates(category);
  if (!candidates.length) return "";
  const lines = candidates.map((post, index) => `${index + 1}. ${post.title} - ${post.url}`).join("\\n");
  return `\n\nInternal-link opportunities from existing ${site.label} posts in this category:\n${lines}\n\nInternal linking requirements:\n- Add 2-4 links only where they help the reader continue the same topic.\n- Use the exact URLs above.\n- Use descriptive anchor text, not "click here".\n- Do not link to the new article itself.\n`;
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

  if (!lengthWasProvided() && process.stdin.isTTY && process.stdout.isTTY) {
    argv.length = await select({
      message: 'How long should each article be?',
      choices: [
        { name: 'Short (about 700-900 words)', value: 'short' },
        { name: 'Medium (about 1,000-1,300 words)', value: 'medium' },
        { name: 'Long (about 1,500-2,200 words)', value: 'long' },
      ],
      default: 'long',
    });
  } else if (!argv.length) {
    argv.length = 'long';
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

  if (isNxtCatalogSeededCategory(category)) {
    const jobs = await buildCatalogProductJobs(category, count);
    return jobs.map((job) => job.topic);
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
  const parsed = parseAiJson(result, { providerName: activeProviderName() });
  const topics = Array.isArray(parsed?.topics) ? parsed.topics : [];
  if (!topics.length) throw new Error(`${activeProviderName()} did not return any topics.`);
  return topics.slice(0, count);
}

async function generatePost(topic, category, { dealProduct = null, catalogProducts = null } = {}) {
  const internalLinkContext = await buildInternalLinkContext(category);
  const isDealsPost = isNxtDealsCategory(category);
  const isSmartHomePost = isNxtSmartHomeCategory(category);
  const seededProducts = Array.isArray(catalogProducts) ? catalogProducts.filter(Boolean) : [];
  const primaryCatalogProduct = seededProducts[0] ?? null;
  const lengthConfig = resolveArticleLengthConfig();
  const wordTarget = isDealsPost ? `at least ${lengthConfig.dealsMin}`
    : isSmartHomePost ? `at least ${lengthConfig.smartHomeMin}`
      : lengthConfig.words;

  const dealContext = dealProductPromptContext(dealProduct);
  const catalogContext = isSmartHomePost ? '' : catalogProductPromptContext(seededProducts, category);
  const smartHomeContext = isSmartHomePost ? smartHomeProductPromptContext(primaryCatalogProduct) : '';
  const contentFormat = site.contentFormat || (isSmartHomePost && primaryCatalogProduct ? 'HTML' : 'Markdown');
  const rankMathRequirements = site.simplePost ? `

Rank Math SEO requirements (mandatory before returning JSON):
- Choose exactly one primary focus keyword/keyphrase and put it first in "seoKeywords". Put related terms after it, comma-separated.
- Start "seoTitle" with the exact primary focus keyword whenever grammar allows; otherwise place it within the first half. Keep the complete SEO title at 60 characters or fewer.
- Put the exact primary focus keyword naturally in "seoDescription"; keep it at 155 characters or fewer.
- Include the primary focus keyword in "slug" and keep the slug concise (75 characters or fewer).
- Use the exact primary focus keyword in the first paragraph, in at least one H2 or H3, and naturally throughout the article. Use it at least once per roughly 250 words while keeping density below 2%; readability takes priority and keyword stuffing is forbidden.
- Do not include an H1 in "content" because WordPress displays the post title as H1.
- Include at least one helpful internal link when internal-link opportunities are supplied, using only the exact supplied URL.
- Write at least 600 words even when the requested topic can be answered briefly. Use short paragraphs and at least one useful list where it improves scanability.
- Make the article title accurate and readable. A number, clear sentiment, or strong action word may be used only when it honestly fits the topic.
- The cover image prompt must visually match the primary focus keyword. Do not put text or logos in the image.
` : '';

  const styleKey = argv['prompt-style'] || 'default';
  const style = PROMPT_STYLES[styleKey] ?? PROMPT_STYLES.default;
  const styleBlock = style.instructions ? `\n${style.instructions}\n` : '';

  const prompt = `${site.editorialBrief}
${styleBlock}
Write one complete blog post.

Topic: ${topic}
Category: ${category || 'General'}
Tone: ${argv.tone}
Length: ${wordTarget} words
Language: ${argv.language}
SEO keywords: ${argv.keywords || 'choose natural keywords from the topic'}
${dealContext}${catalogContext}${smartHomeContext}${internalLinkContext}${rankMathRequirements}

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
  }${style.instructions ? ',' + EDITORIAL_NOTES_SCHEMA : ''}
}

Content requirements:
- ${contentFormat} only in "content".
- Use useful ${contentFormat === 'HTML' ? 'h2/h3' : 'H2/H3'} headings.
- Section headings are level 2; break the longer ones down with level-3 subheadings, at least two sections carrying two or more each. Never go deeper than level 3, and never open with a level-3 heading.
- Include practical comparisons, tips, caveats, and buying/setup guidance where relevant.
- Where useful and natural, add internal links to relevant existing posts from the provided internal-link opportunities. Use Markdown links in Markdown content and <a> tags in HTML content. Do not force every link; 2-4 high-relevance links is better than stuffing.
- When selected NXT.Bargains catalog products are provided, keep the article grounded in those exact products and their product category. Do not invent specs, prices, ratings, or availability.
- For NXT.Bargains product comparison articles with two selected catalog products, compare those exact products side by side and keep both as the main subjects.
- For NXT.Bargains product review articles with a selected catalog product, center the review on that exact product.
- For NXT.Bargains Best Sellers articles, write at least ${lengthConfig.dealsMin} words in "content".
- For NXT.Bargains Best Sellers articles, optimize the title for deal-shopping intent and make it concise, specific, and clickable without sounding spammy.
- For NXT.Bargains Best Sellers articles, make the selected best-seller product the article's main subject and keep the article focused on whether it is a worthwhile deal.
- For NXT.Bargains Best Sellers articles, include why shoppers may want it, where the value is, who should skip it, competing alternatives to compare, and what to check before buying.
- For NXT.Bargains Smart Home articles, write at least ${lengthConfig.smartHomeMin} words in "content".
- For NXT.Bargains Smart Home articles, make the selected smart home product the article's main subject and keep the article focused on setup, compatibility, features, and buyer fit.
- For NXT.Bargains Smart Home articles, include who should consider it, who should skip it, alternatives to compare, and what to verify before buying.
- For NXT.Bargains Smart Home and Best Sellers articles, use valid HTML with useful <h2>, <h3>, <p>, <ul>, and <li> tags only — no <h4> or deeper. Do not include a product snapshot card, summary box, or product image URL; the script inserts those automatically.
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
  const post = parseAiJson(text, { providerName: activeProviderName() });
  validatePost(post);
  validateDealPost(post, category);
  validateSmartHomePost(post, category);
  normalizePostForStrapi(post);
  normalizeContentForSite(post);
  post.slug = slugifyValue(post.slug || post.title);
  selectRankMathFocusKeyword(post);
  validateRankMathPost(post, {
    requireInternalLink: argv.site === 'flightfares.one' && internalLinkContext.length > 0,
  });
  if (seededProducts.length) {
    post.content = rewriteEmbeddedMediaUrls(post.content);
  }
  if (isSmartHomePost && primaryCatalogProduct) {
    post.content = buildSmartHomePostContent(post.content, primaryCatalogProduct);
  }
  post.readingTimeMinutes = Number(post.readingTimeMinutes) || estimateReadingTime(post.content);

  /*
   * editorialNotes has no home in Strapi, so it is printed and then dropped.
   * Leaving it on the object would send an unknown field to the API; the value
   * is in a human reading the intent, the keywords and -- most of all -- what
   * still needs verifying before this goes out.
   */
  if (post.editorialNotes) {
    const n = post.editorialNotes;
    const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    console.log(`\n  -- editorial notes (${styleKey}) --`);
    if (n.searchIntent) console.log(`  intent   : ${n.searchIntent}`);
    if (n.primaryKeyword) console.log(`  keyword  : ${n.primaryKeyword}`);
    if (n.secondaryKeywords) console.log(`  related  : ${n.secondaryKeywords}`);
    if (n.audience) console.log(`  audience : ${n.audience}`);
    if (n.angle) console.log(`  angle    : ${n.angle}`);
    for (const v of list(n.verifyThese)) console.log(`  VERIFY   : ${v}`);
    for (const c of list(n.checklist)) console.log(`  check    : ${c}`);
    console.log('');
    delete post.editorialNotes;
  }
  return post;
}

function normalizeContentForSite(post) {
  if (site.contentFormat !== 'HTML') return;
  const source = String(post.content || '').trim();
  if (!source) return;

  const alreadyHtml = /<\/?(?:p|h[1-6]|ul|ol|li|blockquote|table|figure|img|div|pre|hr)\b[^>]*>/i.test(source);
  if (!alreadyHtml) {
    post.content = marked.parse(source, { gfm: true, breaks: false });
  }
}

function normalizePostForStrapi(post) {
  post.title = limitText(post.title, 255);
  post.slug = slugifyValue(post.slug || post.title);
  post.excerpt = limitText(post.excerpt, 500);
  post.seoTitle = limitText(post.seoTitle, site.simplePost ? 60 : 70);
  post.seoDescription = limitText(post.seoDescription, site.simplePost ? 155 : 160);
  post.seoKeywords = limitText(post.seoKeywords, 255);
}

function validateRankMathPost(post, { requireInternalLink = false } = {}) {
  if (!site.simplePost) return;
  const focusKeyword = String(post.seoKeywords || '').split(',')[0].trim();
  if (!focusKeyword) throw new Error(`${activeProviderName()} did not return a primary Rank Math focus keyword.`);
  const contains = (value) => String(value || '').toLocaleLowerCase().includes(focusKeyword.toLocaleLowerCase());
  const html = String(post.content || '');
  const plainContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const opening = plainContent.slice(0, Math.max(500, Math.floor(plainContent.length * 0.1)));
  const headings = [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, ' ')).join(' ');
  const words = wordCount(plainContent);
  const escapedKeyword = focusKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keywordUses = (plainContent.match(new RegExp(`\\b${escapedKeyword}\\b`, 'gi')) || []).length;
  const minimumKeywordUses = Math.max(2, Math.floor(words / 250));
  const keywordDensity = words ? (keywordUses * focusKeyword.split(/\s+/).length / words) * 100 : 0;
  const internalLinkPattern = new RegExp(
    `<a\\b[^>]*href=["']https?:\\/\\/(?:www\\.)?${site.publicMediaUrl.replace(/^https?:\/\/(?:www\.)?/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/`,
    'i',
  );
  const enforceFlightfaresContentChecks = argv.site === 'flightfares.one';
  const failures = [];
  if (!contains(post.seoTitle)) failures.push('focus keyword missing from SEO title');
  if (!contains(post.seoDescription)) failures.push('focus keyword missing from meta description');
  if (!contains(post.slug.replace(/-/g, ' '))) failures.push('focus keyword missing from slug');
  if (!contains(opening)) failures.push('focus keyword missing near the beginning of content');
  if (!contains(headings)) failures.push('focus keyword missing from H2/H3 headings');
  if (/<h1\b/i.test(html)) failures.push('content contains a duplicate H1');
  if (enforceFlightfaresContentChecks && words < 600) failures.push(`content has ${words} words; Rank Math requires at least 600`);
  if (enforceFlightfaresContentChecks && keywordUses < minimumKeywordUses) failures.push(`focus keyword appears ${keywordUses} times; expected at least ${minimumKeywordUses}`);
  if (enforceFlightfaresContentChecks && keywordDensity > 2) failures.push(`focus keyword density is ${keywordDensity.toFixed(1)}%; keep it at or below 2%`);
  if (requireInternalLink && !internalLinkPattern.test(html)) failures.push('supplied internal-link opportunity was not used');
  if (post.seoTitle.length > 60) failures.push('SEO title exceeds 60 characters');
  if (post.seoDescription.length > 155) failures.push('meta description exceeds 155 characters');
  if (post.slug.length > 75) failures.push('slug exceeds 75 characters');
  if (failures.length) {
    throw new Error(`Rank Math preflight failed: ${failures.join('; ')}. The article was not saved or published.`);
  }
}

function selectRankMathFocusKeyword(post) {
  if (!site.simplePost) return;
  const candidates = String(post.seoKeywords || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!candidates.length) return;
  const html = String(post.content || '');
  const plainContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const opening = plainContent.slice(0, Math.max(500, Math.floor(plainContent.length * 0.1)));
  const headings = [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, ' ')).join(' ');
  const searchable = [post.seoTitle, post.seoDescription, post.slug.replace(/-/g, ' '), opening, headings]
    .map((value) => String(value || '').toLocaleLowerCase());
  const selected = candidates
    .filter((keyword) => keyword.split(/\s+/).length <= 5)
    .find((keyword) => searchable.every((value) => value.includes(keyword.toLocaleLowerCase())));
  if (!selected || selected === candidates[0]) return;
  post.seoKeywords = [selected, ...candidates.filter((keyword) => keyword !== selected)].join(', ');
  console.log(`  · Rank Math focus keyword adjusted to an exact on-page phrase: ${selected}`);
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

async function uploadImageToStrapi(imageUrl, filename, { returnAsset = false } = {}) {
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
  if (!returnAsset) return first.id;
  const publicStrapiBase = String(STRAPI_PUBLIC_URL || NEXT_PUBLIC_STRAPI_URL || STRAPI_URL || '').replace(/\/$/, '');
  return {
    id: first.id,
    url: /^https?:\/\//i.test(String(first.url || ''))
      ? first.url
      : `${publicStrapiBase}${String(first.url || '').startsWith('/') ? '' : '/'}${first.url || ''}`,
  };
}

async function generateAndUploadImages(post) {
  const prompts = post?.imagePrompts;
  const needsInlineImages = argv.site === 'flightfares.one';
  if (!prompts?.cover || (needsInlineImages && (!Array.isArray(prompts.gallery) || prompts.gallery.length < 2))
    || (!site.simplePost && (!Array.isArray(prompts.gallery) || prompts.gallery.length < 1))) {
    console.log(`  (no image prompts returned by ${activeProviderName()} - skipping images)`);
    return { coverId: null, galleryIds: [], galleryAssets: [] };
  }

  const baseName = slugifyValue(post.title || 'site-post').slice(0, 50);
  // FlightFares embeds both gallery images in its WordPress-compatible body.
  // Other simple WordPress collections retain their cover-only behaviour.
  const galleryPrompts = needsInlineImages
    ? prompts.gallery.slice(0, 2)
    : site.simplePost ? [] : prompts.gallery.slice(0, 2);
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
      const asset = await uploadImageToStrapi(url, `${baseName}-${kind}`, { returnAsset: true });
      return { kind, prompt, ...asset };
    }),
  );

  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const coverId = results.find((result) => result.kind === 'cover')?.id ?? null;
  const galleryAssets = results.filter((result) => result.kind !== 'cover');
  const galleryIds = galleryAssets.map((result) => result.id);
  return { coverId, galleryIds, galleryAssets };
}

function insertFlightfaresInlineImages(content, post, galleryAssets = []) {
  if (argv.site !== 'flightfares.one' || !galleryAssets.length) return content;

  const html = String(content || '');
  const paragraphEnds = [...html.matchAll(/<\/p\s*>/gi)].map((match) => match.index + match[0].length);
  if (!paragraphEnds.length) return html;

  const placements = galleryAssets.slice(0, 2).map((asset, index) => {
    const target = Math.min(
      paragraphEnds.length - 1,
      Math.max(0, Math.floor(paragraphEnds.length * ((index + 1) / 3))),
    );
    const alt = `${post.title} - travel image ${index + 1}`.slice(0, 180);
    const figure = `\n<figure class="wp-block-image size-large"><img src="${escapeAttr(asset.url)}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async"></figure>\n`;
    return { position: paragraphEnds[target], figure };
  });

  return placements
    .sort((a, b) => b.position - a.position)
    .reduce((output, item) => `${output.slice(0, item.position)}${item.figure}${output.slice(item.position)}`, html);
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

  // The WordPress-backed post collections intentionally have a smaller schema
  // than the commerce/editorial collections. Do not send fields Strapi would
  // reject as unknown attributes.
  if (site.simplePost) {
    delete data.postType;
    delete data.readingTimeMinutes;
  }

  if (categoryId) data.categories = [categoryId];
  if (coverId) data.coverImage = coverId;
  if (galleryIds?.length && !site.simplePost) data.gallery = galleryIds;
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

    if (isNxtCatalogSeededCategory(argv.category)) {
      return buildCatalogProductJobs(argv.category, argv.count);
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

      if (isNxtCatalogSeededCategory(category)) {
        const catalogJobs = await buildCatalogProductJobs(category, perCategory);
        jobs.push(...catalogJobs);
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

function isNxtCatalogSeededCategory(category) {
  if (argv.site !== 'nxt.bargains') return false;
  if (isNxtDealsCategory(category)) return false;
  return Boolean(NXT_EDITORIAL_COMMERCE_MAP[slugifyValue(category || '')]);
}

function commerceSlugsForEditorialCategory(category) {
  return NXT_EDITORIAL_COMMERCE_MAP[slugifyValue(category || '')] || [];
}

function catalogProductsNeededForEditorialCategory(category) {
  return slugifyValue(category || '') === 'product-comparisons' ? 2 : 1;
}

async function enrichJobWithProductSeed(job) {
  if (isNxtDealsCategory(job.category) && !job.dealProduct) {
    return {
      ...job,
      dealProduct: pickRandomDealProducts(1)[0],
    };
  }

  if (isNxtCatalogSeededCategory(job.category) && !job.catalogProducts?.length) {
    const { products, topic } = await pickCatalogProductsForEditorial(job.category);
    return {
      ...job,
      catalogProducts: products,
      topic: job.topic || topic,
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

async function loadNxtCommerceProducts(categorySlugs = NXT_ALL_COMMERCE_SLUGS) {
  const normalizedSlugs = [...new Set(categorySlugs.map((slug) => slugifyValue(slug)).filter(Boolean))];
  const slugsToLoad = normalizedSlugs.filter((slug) => !commerceProductsCache.byCategorySlug.has(slug));

  for (const categorySlug of slugsToLoad) {
    const categoryMeta = NXT_COMMERCE_CATEGORY_BY_SLUG[categorySlug];
    if (!categoryMeta) continue;

    const products = [];
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
        'populate[primaryImage][fields][0]': 'url',
        'populate[primaryImage][fields][1]': 'alternativeText',
        'populate[offers][fields][0]': 'price',
        'populate[offers][fields][1]': 'originalPrice',
        'populate[offers][fields][2]': 'currency',
        'populate[offers][fields][3]': 'status',
        'sort[0]': 'updatedAt:desc',
      });
      const response = await strapi(`/api/commerce-products?${params.toString()}`);
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows) {
        const normalized = normalizeCommerceProduct(row, categoryMeta);
        if (normalized) products.push(normalized);
      }

      const pageCount = response?.meta?.pagination?.pageCount ?? 1;
      if (page >= pageCount || rows.length === 0) break;
      page += 1;
    }

    commerceProductsCache.byCategorySlug.set(categorySlug, products);
    commerceProductsCache.all.push(...products);
  }

  const loadedProducts = normalizedSlugs.flatMap((slug) => commerceProductsCache.byCategorySlug.get(slug) || []);
  if (!loadedProducts.length) {
    fatal(`No active NXT.Bargains catalog products found for categories: ${normalizedSlugs.join(', ')}`);
  }

  return loadedProducts;
}

function normalizeCommerceProduct(row, categoryMeta) {
  const title = String(row?.name || row?.title || '').trim();
  const slug = String(row?.slug || '').trim();
  if (!title || !slug) return null;

  const categorySlug = row?.categories?.[0]?.slug || categoryMeta.slug;
  const meta = NXT_COMMERCE_CATEGORY_BY_SLUG[categorySlug] || categoryMeta;
  const brand = row?.brandRef?.name || row?.brand || row?.specs?.technicalSpecs?.Brand || null;

  return {
    documentId: row.documentId,
    title,
    slug,
    categorySlug,
    categoryLabel: meta.label,
    categoryPage: meta.categoryPage,
    shortDescription: String(row?.shortDescription || '').trim(),
    brand: brand ? String(brand).trim() : null,
    imageUrl: resolveProductImageUrl(row),
    sourceUrl: row?.specs?.sourceUrl || row?.specs?.specSourceUrl || null,
    productUrl: `${NXT_BARGAINS_SITE_URL}/${categorySlug}/${slug}`,
    displayPrice: catalogProductDisplayPrice(row),
  };
}

function catalogProductDisplayPrice(row) {
  const offers = Array.isArray(row?.offers) ? row.offers : [];
  const activeOffers = offers.filter((offer) => !offer?.status || offer.status === 'active');
  const pool = activeOffers.length ? activeOffers : offers;

  let bestPrice = null;
  let bestCurrency = 'USD';
  for (const offer of pool) {
    const price = Number(offer?.price ?? offer?.originalPrice);
    if (!Number.isFinite(price)) continue;
    if (bestPrice === null || price < bestPrice) {
      bestPrice = price;
      bestCurrency = offer?.currency || 'USD';
    }
  }

  if (bestPrice === null) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: bestCurrency,
    maximumFractionDigits: bestPrice % 1 === 0 ? 0 : 2,
  }).format(bestPrice);
}

function catalogCarouselPriceMarkup(product) {
  if (!product?.displayPrice) return '';
  return `<span class="nxt-product-carousel__price">${escapeHtml(product.displayPrice)}</span>`;
}

async function pickCatalogProductsForEditorial(editorialCategory, { commerceCategorySlug = null } = {}) {
  const allowedSlugs = commerceSlugsForEditorialCategory(editorialCategory);
  if (!allowedSlugs.length) {
    fatal(`No commerce category mapping configured for editorial category "${editorialCategory}".`);
  }

  const targetSlug = commerceCategorySlug && allowedSlugs.includes(commerceCategorySlug)
    ? commerceCategorySlug
    : allowedSlugs[Math.floor(Math.random() * allowedSlugs.length)];

  await loadNxtCommerceProducts([targetSlug]);
  const pool = [...(commerceProductsCache.byCategorySlug.get(targetSlug) || [])];
  if (!pool.length) {
    fatal(`No active NXT.Bargains products found in ${targetSlug}.`);
  }

  shuffleInPlace(pool);
  const needed = catalogProductsNeededForEditorialCategory(editorialCategory);
  const products = pool.slice(0, Math.min(needed, pool.length));
  return {
    commerceCategorySlug: targetSlug,
    products,
    topic: topicForCatalogProducts(products, editorialCategory),
  };
}

async function buildCatalogProductJobs(editorialCategory, count = 1) {
  const jobs = [];
  const allowedSlugs = commerceSlugsForEditorialCategory(editorialCategory);

  for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
    const commerceCategorySlug = allowedSlugs[index % allowedSlugs.length];
    const { products, topic } = await pickCatalogProductsForEditorial(editorialCategory, { commerceCategorySlug });
    jobs.push({
      category: editorialCategory,
      topic,
      catalogProducts: products,
    });
  }

  return jobs;
}

function topicForCatalogProducts(products, editorialCategory) {
  const [primary, secondary] = products;
  if (!primary) return 'Untitled catalog article';

  const editorialSlug = slugifyValue(editorialCategory || '');
  const categoryLabel = primary.categoryLabel;

  if (editorialSlug === 'product-comparisons' && secondary) {
    return `${primary.title} vs ${secondary.title}: which ${categoryLabel} is the better buy?`;
  }
  if (editorialSlug === 'product-reviews') {
    return `Review: Is ${primary.title} worth buying?`;
  }
  if (editorialSlug === 'product-roundups') {
    return `Best ${categoryLabel} picks to compare right now, starting with ${primary.title}`;
  }
  if (editorialSlug === 'buying-guides') {
    return `How to choose the right ${categoryLabel}: ${primary.title} and what to compare`;
  }
  if (editorialSlug === 'how-to-guides') {
    return `How to set up and get the most from ${primary.title}`;
  }
  if (editorialSlug === 'top-rated-smart-electronics-devices') {
    return `Top-rated ${categoryLabel}: why ${primary.title} stands out`;
  }
  if (editorialSlug === 'nxt-bargains-informative-articles') {
    return `${categoryLabel} explained: what ${primary.title} tells shoppers`;
  }
  if (editorialSlug === NXT_SMART_HOME_CATEGORY) {
    return smartHomeTopicForProduct(primary);
  }

  return `${categoryLabel}: Is ${primary.title} worth checking on NXT.Bargains?`;
}

function catalogProductPromptContext(products, editorialCategory) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  if (!list.length) return '';

  const editorialSlug = slugifyValue(editorialCategory || '');
  const productBlocks = list.map((product, index) => `Product ${index + 1}:
- Product category: ${product.categoryLabel}
- Category page: ${product.categoryPage}
- Product title: ${product.title}
- Brand: ${product.brand ?? 'not listed'}
- Short description: ${product.shortDescription || 'not listed'}
- NXT.Bargains product page: ${product.productUrl}
- Merchant/source URL: ${product.sourceUrl ?? 'not listed'}`).join('\n\n');

  const comparisonRule = editorialSlug === 'product-comparisons' && list.length > 1
    ? '- Compare the selected catalog products directly. Keep both products as the main subjects and stay within the same product category.'
    : '- Keep the selected catalog product as the main subject throughout the article. Do not drift into a generic category roundup.';

  return `

Selected NXT.Bargains catalog product context:
${productBlocks}

Catalog-grounded article requirements:
- Base the article on the selected product(s) from the NXT.Bargains catalog above.
${comparisonRule}
- Keep the article aligned with the same or similar product category shown above.
- Mention the product category naturally and link to the NXT.Bargains product page when relevant.
- Do not invent exact prices, ratings, certifications, compatibility claims, or specs that are not provided.
- Do not claim the product is objectively the best; explain practical reasons it may or may not fit the shopper.`;
}

function shuffleInPlace(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function publicMediaBase() {
  return String(
    STRAPI_PUBLIC_URL
    || NEXT_PUBLIC_STRAPI_URL
    || site?.publicMediaUrl
    || 'https://nxt.bargains',
  ).replace(/\/$/, '');
}

function privateStrapiBase() {
  return String(STRAPI_URL || '').replace(/\/$/, '');
}

function isLocalStrapiUrl(value) {
  try {
    const url = new URL(String(value));
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function resolveProductImageUrl(row) {
  const primaryImageUrl = row?.primaryImage?.url;
  if (primaryImageUrl) return absolutizeMediaUrl(primaryImageUrl);

  const specs = row?.specs || {};
  const candidates = [specs.sourceImageUrl, specs.imageUrl];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    if (/^https?:\/\//i.test(candidate) && !isLocalStrapiUrl(candidate)) {
      return candidate.trim();
    }
  }

  return absolutizeMediaUrl(specs.imageUrl || specs.sourceImageUrl || null);
}

function absolutizeMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const publicBase = publicMediaBase();
  const apiBase = privateStrapiBase();

  if (/^https?:\/\//i.test(raw)) {
    if (apiBase && raw.startsWith(apiBase)) {
      return `${publicBase}${raw.slice(apiBase.length)}`;
    }
    if (isLocalStrapiUrl(raw)) {
      const { pathname, search } = new URL(raw);
      return `${publicBase}${pathname}${search}`;
    }
    return raw;
  }

  return `${publicBase}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function rewriteEmbeddedMediaUrls(html) {
  let content = String(html || '');
  const publicBase = publicMediaBase();
  const apiBase = privateStrapiBase();

  if (apiBase) {
    content = content.split(apiBase).join(publicBase);
  }

  return content.replace(
    /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(\/[^"'\\s>]*)/gi,
    `${publicBase}$1`,
  );
}

async function pickRandomSmartHomeProducts(count = 1) {
  const jobs = await buildCatalogProductJobs(NXT_SMART_HOME_CATEGORY, count);
  return jobs.map((job) => job.catalogProducts[0]).filter(Boolean);
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
- Write at least ${resolveArticleLengthConfig().smartHomeMin} words of article content.
- Focus on setup, compatibility, automation, security, energy, convenience, and buyer fit for smart home shoppers.
- Include who should consider it, who should skip it, alternatives to compare, and what to verify before buying.
- Mention the product category and link naturally to the NXT.Bargains product page when relevant.
- Do not invent exact prices, ratings, certifications, compatibility claims, or specs that are not provided.
- Do not claim the product is objectively the best; explain practical reasons it may or may not fit a smart home setup.`;
}

function buildSmartHomePostContent(html, product) {
  const content = sanitizeGeneratedHtml(html);
  const card = buildSmartHomeProductCard(product);
  return rewriteEmbeddedMediaUrls(`${card}\n${insertSmartHomeProductCarouselInMiddle(content, product)}`);
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
  const siblings = (commerceProductsCache.byCategorySlug.get(product.categorySlug) || [])
    .filter((item) => item.slug !== product.slug && item.imageUrl)
    .slice(0, NXT_SMART_HOME_PRODUCT_CAROUSEL_LIMIT);

  if (!siblings.length) return '';

  const cards = siblings.map((item) => `<a class="nxt-product-carousel__item" href="${escapeAttr(item.productUrl)}" target="_blank" rel="noopener">
<span class="nxt-product-carousel__image"><img src="${escapeAttr(item.imageUrl)}" alt="${escapeAttr(item.title)}" loading="lazy" /></span>
<span class="nxt-product-carousel__body">
<span class="nxt-product-carousel__title">${escapeHtml(item.title)}</span>
<span class="nxt-product-carousel__meta">${escapeHtml(item.categoryLabel)}</span>
${catalogCarouselPriceMarkup(item)}
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
- Write at least ${resolveArticleLengthConfig().dealsMin} words of article content.
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

function validatePost(post) {
  const required = ['title', 'excerpt', 'content', 'seoTitle', 'seoDescription', 'seoKeywords'];
  for (const field of required) {
    if (!post?.[field]) throw new Error(`${activeProviderName()} response missing "${field}".`);
  }
}

function validateDealPost(post, category) {
  if (!isNxtDealsCategory(category)) return;
  const minWords = resolveArticleLengthConfig().dealsMin;
  const words = wordCount(post.content);
  if (words < minWords) {
    throw new Error(
      `${activeProviderName()} returned a Best Sellers article with ${words} words; minimum is ${minWords}. Run again or increase max tokens.`,
    );
  }
}

function validateSmartHomePost(post, category) {
  if (!isNxtSmartHomeCategory(category)) return;
  const minWords = resolveArticleLengthConfig().smartHomeMin;
  const words = wordCount(post.content);
  if (words < minWords) {
    throw new Error(
      `${activeProviderName()} returned a Smart Home article with ${words} words; minimum is ${minWords}. Run again or increase max tokens.`,
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
  console.log(`AI: ${aiProvider} | Model: ${activeModel()} | length: ${articleLengthLabel()} | dry-run: ${argv['dry-run']} | publish: ${argv.publish} | images: ${argv.images}\n`);

  const jobs = await buildJobs();
  console.log(`Queue: ${jobs.length} post(s)\n`);

  const results = [];
  for (const [index, job] of jobs.entries()) {
    console.log(`[${index + 1}/${jobs.length}] Generating: ${job.topic}`);
    // Resolve (and, when needed, create) the category before calling the paid
    // AI provider. A Strapi permission or connectivity failure should stop the
    // run before generation tokens are spent, not after the article is ready.
    const categoryId = argv['dry-run'] ? null : await resolveCategoryId(job.category);
    if (job.dealProduct) {
      console.log(`  best-seller seed: ${job.dealProduct.marketplace} #${job.dealProduct.rank ?? '?'} · ${job.dealProduct.title}`);
    }
    if (job.catalogProducts?.length) {
      console.log(`  catalog seed: ${job.catalogProducts.map((product) => `${product.categoryLabel} · ${product.title}`).join(' | ')}`);
    }
    const post = await generatePost(job.topic, job.category, {
      dealProduct: job.dealProduct,
      catalogProducts: job.catalogProducts,
    });

    if (argv['dry-run']) {
      console.log(JSON.stringify({
        site: argv.site,
        category: job.category,
        dealProduct: job.dealProduct ?? null,
        catalogProducts: job.catalogProducts ?? null,
        data: post,
      }, null, 2));
      results.push({ topic: job.topic, slug: post.slug, status: 'dry-run' });
      continue;
    }

    let coverId = null;
    let galleryIds = [];
    let galleryAssets = [];
    if (argv.images) {
      try {
        if (job.catalogProducts?.[0]?.imageUrl) {
          coverId = await uploadImageToStrapi(
            job.catalogProducts[0].imageUrl,
            slugifyValue(post.title).slice(0, 60),
          );
        } else {
          ({ coverId, galleryIds, galleryAssets } = await generateAndUploadImages(post));
        }
      } catch (error) {
        console.log(`  image step failed (${error.message.slice(0, 140)}) - saving post without images`);
      }
    }

    if (galleryAssets.length) {
      post.content = insertFlightfaresInlineImages(post.content, post, galleryAssets);
      console.log(`  embedded ${galleryAssets.length} contextual image(s) in the article body`);
    }

    const saved = await postToStrapi(post, {
      categoryId,
      coverId,
      galleryIds,
      sourceUrl: job.catalogProducts?.[0]?.productUrl || job.dealProduct?.url || null,
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
