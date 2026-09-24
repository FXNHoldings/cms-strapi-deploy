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
    /*
     * HTML, not Markdown. bls-post.content is rendered with
     * dangerouslySetInnerHTML, so Markdown reaches the page as literal "##" and
     * "**" -- which is what happened to the first published batch. All 120
     * pre-existing posts are HTML (<p>, <h2>), so this matches the collection
     * rather than changing it.
     */
    contentFormat: 'HTML',
    postEndpoint: '/api/bls-posts',
    categoryEndpoint: '/api/bls-categories',
    adminUid: 'api::bls-post.bls-post',
    publicMediaUrl: 'https://bestlooking.skin',
    defaultPostType: 'informative',
    // The topic hubs posts are filed under (each has a parent group). The five
    // old format categories (product-comparisons, ...) were retired on
    // 15 Sep 2026 and the three *-hubs rows are group parents, not topics.
    defaultCategories: [
      'sunscreen', 'face-masks', 'exfoliants', 'eye-cream', 'cleansers', 'moisturizers', 'serums',
      'sensitive-skin', 'hyperpigmentation', 'anti-aging', 'acne',
      'korean-skincare', 'dupes', 'ingredients', 'routines',
    ],
    // Only categories under a group parent are offered in the prompt.
    categoryParentRequired: true,
    postTypeChoices: [
      ['informative', 'Informative article'],
      ['how-to-guide', 'How-to guide'],
      ['product-review', 'Product review'],
      ['product-comparison', 'Product comparison'],
      ['product-roundup', 'Product roundup'],
      ['top-rated', 'Top-rated list'],
      ['pillar', 'Pillar / complete guide'],
    ],
    editorialBrief:
      'Write careful skincare content for BestLooking.Skin. Focus on routines, ingredients, comparisons, product reviews, skin types, and practical guidance. Do not make medical claims or promise results.',
    topicNiche: 'skincare, beauty products, routines, ingredients, product reviews',
    // bls-post has a showFrom release date; see --publishedAt.
    supportsShowFrom: true,
    // Inline product boxes: ::product:<slug>:: markers for this storefront's
    // commerce-products (Strapi, site bestlooking-skin, listable only), which
    // the site renders as boxes (projects/bestlooking.skin/lib/product-boxes.ts).
    // "Where to buy" comes from the same products' stored retailer offers, so
    // it costs no API calls. A post with fewer than `min` boxes is still saved
    // as asked (routines/ingredients topics often have no fitting product).
    productCatalog: {
      strapiSite: 'bestlooking-skin',
      // Topic hub -> commerce category (the site's HUB_TO_COMMERCE).
      hubMap: {
        serums: 'facial-serums', moisturizers: 'moisturisers', cleansers: 'facial-cleansers',
        exfoliants: 'exfoliators-and-scrubs', 'anti-aging': 'anti-aging', 'eye-cream': 'anti-aging',
        'sensitive-skin': 'moisturisers', acne: 'facial-cleansers', hyperpigmentation: 'facial-serums',
        sunscreen: 'moisturisers',
      },
      catalogueNote: 'real skincare products stocked by this site',
      min: 2,
      max: 4,
      candidates: 8,
      requireMin: false,
      offerLinks: { perProduct: 3, exclude: /^(amazon|poshmark|mercari)/i },
    },
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
  'nxtsmarthome.com.au': {
    label: 'NXT Smart Home (nxtsmarthome.com.au)',
    // Markdown: nxtsmarthome-post.content is rendered by the site's markdown
    // pipeline (lib/content.ts), which also expands ::product:<slug>:: markers.
    postEndpoint: '/api/nxtsmarthome-posts',
    categoryEndpoint: '/api/nxtsmarthome-categories',
    adminUid: 'api::nxtsmarthome-post.nxtsmarthome-post',
    publicMediaUrl: 'https://nxtsmarthome.com.au',
    defaultPostType: 'informative',
    // Category slugs in Strapi are the site's category keys (lib/site.ts).
    defaultCategories: [
      'security',
      'lighting',
      'energy',
      'entertainment',
      'climate',
      'hubs-and-platforms',
      'robot-vacuums',
      'setup-guides',
      'buying-guides',
    ],
    // Names shown in the prompt: the site's labels (lib/site.ts), which are
    // fuller than the CMS category names.
    categoryLabels: {
      security: 'Security & Cameras',
      lighting: 'Lighting',
      energy: 'Energy & Solar',
      entertainment: 'Entertainment & Audio',
      climate: 'Climate & Comfort',
      'hubs-and-platforms': 'Hubs & Platforms',
      'robot-vacuums': 'Robot Vacuums',
      'setup-guides': 'Setup Guides',
      'buying-guides': 'Buying Guides',
    },
    postTypeChoices: [
      ['informative', 'Explainer / informative'],
      ['how-to-guide', 'How-to guide'],
      ['buying-guide', 'Buying guide'],
      ['product-comparison', 'Comparison'],
      ['product-roundup', 'Roundup'],
      ['product-review', 'Review'],
      ['pillar', 'Pillar / complete guide'],
    ],
    // Real catalogue products are offered to the writer and placed inline as
    // ::product:<slug>:: markers (rendered as ProductBoxes by the site). Site
    // rule 8: at least two per article, only products it discusses, only
    // products with a verdict. See siteProductContext / applySiteProducts.
    productCatalog: {
      path: process.env.NXTSMARTHOME_CATALOG || '/opt/projects/nxtsmarthome.com.au/public/data/products.json',
      min: 2,
      max: 4,
      candidates: 8,
      // "Where to buy" section: live Australian sellers from DataForSEO Google
      // Shopping (location 2036 = Australia).
      affiliateOffers: { location: 2036, language: 'en', perProduct: 3 },
    },
    // The site renders FAQs from the post's faq component (its FAQ design and
    // FAQPage structured data), not from headings in the body. See extractFaqToField.
    faqToField: true,
    // nxtsmarthome-post has a showFrom release date; see --publishedAt.
    supportsShowFrom: true,
    hasPublishDate: true,
    // Each post is bylined to one of these nxtsmarthome-author slugs, picked at
    // random. The "NXT Smart Home Editorial" fallback byline is never used.
    authorEndpoint: '/api/nxtsmarthome-authors',
    authorSlugs: ['adrian-thompson', 'k-curtis', 'harry-cheng'],
    editorialBrief:
      'Write practical smart home content for Australian homes for NXT Smart Home. Australian English (optimise, colour), AUD, Australian retailers, 240V power, AS/NZS rules, renters and strata where relevant. Never invent prices, specs, test results or ratings, and never imply hands-on testing that did not happen. Do not state electrical, privacy or tenancy law as settled fact; recommend a licensed electrician for fixed wiring.',
    topicNiche: 'smart home devices for Australian homes: security cameras, lighting, energy and solar, climate, entertainment, hubs and platforms, robot vacuums, setup and buying guides',
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
  .option('publishedAt', {
    alias: 'published-at',
    type: 'string',
    describe:
      'Release date/time for the article (sites with showFrom: nxtsmarthome.com.au, bestlooking.skin). '
      + 'The post is saved Published with showFrom = this time and stays hidden on the site until then. '
      + 'ISO format, e.g. 2026-10-01T09:00; no timezone means Australia/Perth (+08:00). Implies --publish.',
  })
  .option('publish-every', {
    type: 'number',
    describe: 'With --publishedAt and several articles: hours between each release (e.g. 24 = one a day).',
  })
  .option('skip-rank-math-test', {
    type: 'boolean',
    default: false,
    hidden: true,
    describe: 'Save without blocking on the Rank Math preflight (used by the WordPress Content Jobs entry point).',
  })
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
  .option('affiliate-links', {
    type: 'boolean',
    default: true,
    describe: 'nxtsmarthome.com.au: append a "Where to buy" list of live Australian retailer links for the featured products (DataForSEO, ~$0.001 per product). --no-affiliate-links to skip.',
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

  // Topic files carry their own postType per row, so no prompt for those.
  if (site.postTypeChoices && !argv['post-type'] && !argv.topics && process.stdin.isTTY && process.stdout.isTTY) {
    argv['post-type'] = await select({
      message: 'What kind of article?',
      choices: site.postTypeChoices.map(([value, name]) => ({ name: `${name} (${value})`, value })),
      default: site.defaultPostType,
    });
  }

  // Draft, publish now, or schedule (sites whose post type has showFrom).
  if (!argv.publish && !argv.publishedAt && !argv['dry-run'] && process.stdin.isTTY && process.stdout.isTTY) {
    const choices = [
      { name: 'Save as draft (review in Strapi, publish later)', value: 'draft' },
      { name: 'Publish now', value: 'now' },
    ];
    if (site.supportsShowFrom) choices.push({ name: 'Schedule: publish at a date/time', value: 'schedule' });
    const mode = await select({ message: 'Publishing:', choices });
    if (mode === 'now') argv.publish = true;
    if (mode === 'schedule') {
      argv.publishedAt = await input({
        message: 'Release date/time (Perth time), e.g. 2026-10-01 09:00:',
        validate: (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value).trim()) ? true : 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM'),
      });
      if ((argv.count || 0) > 1 || argv.topics) {
        const every = await input({ message: 'Hours between releases (0 = all at once):', default: '24' });
        if (Number(every) > 0) argv['publish-every'] = Number(every);
      }
    }
  }
  resolveRelease();

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

/**
 * The site's categories as they are in Strapi, for the prompt: [{ slug, name, group }].
 * Falls back to the built-in defaultCategories if the CMS cannot be reached.
 */
async function loadSiteCategories() {
  try {
    const params = new URLSearchParams({
      'pagination[pageSize]': '100',
      'fields[0]': 'slug',
      'fields[1]': 'name',
      'sort[0]': 'name:asc',
    });
    if (site.categoryParentRequired) {
      params.set('populate[parent][fields][0]', 'slug');
      params.set('populate[parent][fields][1]', 'name');
    }
    const json = await strapi(`${site.categoryEndpoint}?${params}`);
    const rows = (json?.data || [])
      .filter((c) => c?.slug)
      .filter((c) => !site.categoryParentRequired || c.parent?.slug)
      .map((c) => ({
        slug: c.slug,
        name: site.categoryLabels?.[c.slug] || c.name || titleCase(c.slug),
        group: c.parent?.name || '',
      }));
    if (rows.length) {
      return rows.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    }
  } catch (error) {
    console.warn(`Could not load ${site.label} categories from Strapi (${error.message}); using the built-in list.`);
  }
  return site.defaultCategories.map((slug) => ({
    slug,
    name: site.categoryLabels?.[slug] || titleCase(slug),
    group: '',
  }));
}

async function promptForCategory() {
  const customValue = '__custom__';
  const categories = await loadSiteCategories();
  const picked = await select({
    message: `Which ${site.label} category should this use?`,
    pageSize: Math.min(categories.length + 1, 20),
    choices: [
      ...categories.map((category) => ({
        name: `${category.group ? `${category.group} › ` : ''}${category.name} (${category.slug})`,
        value: category.slug,
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

/* ---------------------------------------------------------------------------
 * Site product catalogue (nxtsmarthome.com.au)
 *
 * The site renders a line "::product:<slug>::" as an inline ProductBox (photo,
 * what it suits, buy buttons) from its catalogue, public/data/products.json.
 * Its editorial rule 8 requires at least two per article, drawn from products
 * the article genuinely discusses, that have a verdict (bestFor or pros), and
 * that match the category. So the writer gets a shortlist of real catalogue
 * products for the topic and places the markers itself, next to the prose that
 * discusses each; applySiteProducts() then validates what came back.
 * ------------------------------------------------------------------------- */
let siteCatalogCache = null;

/**
 * Catalogues kept in Strapi (productCatalog.strapiSite) are fetched once per run
 * and shaped like the JSON catalogue entries the rest of this code expects.
 */
async function preloadSiteCatalog() {
  const cfg = site.productCatalog;
  if (!cfg?.strapiSite || siteCatalogCache) return;
  const list = [];
  try {
    for (let page = 1; page <= 20; page += 1) {
      const q = [
        `filters[site][slug][$eq]=${encodeURIComponent(cfg.strapiSite)}`,
        'filters[productStatus][$eq]=active',
        'fields[0]=slug', 'fields[1]=name', 'fields[2]=brand', 'fields[3]=specs', 'fields[4]=rating', 'fields[5]=ratingCount',
        'populate[categories][fields][0]=slug',
        'populate[offers][fields][0]=productUrl', 'populate[offers][fields][1]=price', 'populate[offers][fields][2]=availability',
        'populate[offers][populate][merchant][fields][0]=name', 'populate[offers][populate][merchant][fields][1]=slug',
        `pagination[page]=${page}`, 'pagination[pageSize]=100',
      ].join('&');
      const res = await strapi(`/api/commerce-products?${q}`);
      list.push(...(res?.data || []));
      if (page >= (res?.meta?.pagination?.pageCount || 1)) break;
    }
  } catch (error) {
    console.warn(`Product catalogue not readable (Strapi commerce-products, site ${cfg.strapiSite}): ${error.message}`);
  }
  const hubsFor = (catSlugs) => Object.entries(cfg.hubMap || {}).filter(([, c]) => catSlugs.includes(c)).map(([hub]) => hub);
  siteCatalogCache = list.map((p) => {
    const specs = p.specs || {};
    const cats = (p.categories || []).map((c) => c.slug);
    const features = (Array.isArray(specs.keyFeatures) ? specs.keyFeatures : []).slice(0, 2).join('; ');
    const concerns = [specs['Skin Concerns'], specs['Skin Type'], specs['Key Ingredient']].filter(Boolean).join('; ');
    return {
      slug: p.slug,
      name: p.name,
      brand: p.brand || '',
      subCategory: cats[0] || '',
      categoryKeys: hubsFor(cats),
      bestFor: [features, concerns].filter(Boolean).join(' | '),
      // e.g. "Korean Cosmetics, Kbeauty": lets a Korean-skincare topic find Korean products.
      theme: [specs.Theme, specs['Country of Origin']].filter(Boolean).join(' '),
      reviewCount: p.ratingCount || 0,
      offers: p.offers || [],
    };
  }).filter((p) => p.slug && p.name && p.bestFor);
  console.log(`  catalogue: ${siteCatalogCache.length} products (Strapi, ${cfg.strapiSite})`);
}

function loadSiteCatalog() {
  if (!site.productCatalog) return [];
  if (siteCatalogCache) return siteCatalogCache;
  if (site.productCatalog.strapiSite) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(site.productCatalog.path, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.products || [];
    siteCatalogCache = list.filter((p) => p?.slug && p?.name && (
      (typeof p.bestFor === 'string' && p.bestFor.trim()) || (Array.isArray(p.pros) && p.pros.length)
    ));
  } catch (error) {
    console.warn(`Product catalogue not readable (${site.productCatalog.path}): ${error.message}`);
    siteCatalogCache = [];
  }
  return siteCatalogCache;
}

const PRODUCT_STOPWORDS = new Set('a an and are as at australia australian aussie be best buy by can do does for from guide how in into is it its of on or smart home homes that the their this to vs what when where which why will with without you your skin skincare face facial product products use using'.split(' '));
const productTokens = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9+ ]+/g, ' ').split(/\s+/)
  .filter((w) => w.length > 2 && !PRODUCT_STOPWORDS.has(w))
  .map((w) => w.replace(/s$/, ''));

/** Up to `candidates` catalogue products most relevant to the topic. */
function pickSiteProducts(topic, category) {
  const catalog = loadSiteCatalog();
  if (!catalog.length) return [];
  const want = new Set(productTokens(topic));
  const inCat = (p) => p.categoryKey === category || (p.categoryKeys || []).includes(category);
  const hasCategory = catalog.some(inCat);
  const scored = catalog.map((p) => {
    const words = new Set(productTokens(`${p.name} ${p.brand} ${p.subCategory} ${p.bestFor} ${p.theme || ''}`));
    let overlap = 0;
    for (const w of want) if (words.has(w)) overlap += 1;
    const inCategory = inCat(p);
    const reviews = Number(p.reviewCountReal || p.reviewCount || 0);
    const score = overlap * 3 + (inCategory ? 4 : 0) + Math.log10(reviews + 1);
    return { p, score, overlap, inCategory };
  })
    // Product categories keep to their own products (plus clear topical matches);
    // topic-only categories (setup-guides, buying-guides) rely on topic overlap.
    .filter((x) => (hasCategory ? x.inCategory || x.overlap >= 2 : x.overlap >= 1))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, site.productCatalog.candidates).map((x) => x.p);
}

function siteProductContext(products) {
  if (!products.length) return '';
  const { min, max } = site.productCatalog;
  const lines = products.map((p) => `- ${p.slug} | ${p.brand ? `${p.brand} ` : ''}${p.name} | ${p.subCategory || p.categoryName || ''} | best for: ${String(p.bestFor || '').replace(/\s+/g, ' ').slice(0, 160)}`);
  return `

Catalogue products (${site.productCatalog.catalogueNote || 'real products sold in Australia'}, from this site's catalogue):
${lines.join('\n')}

Product placement (mandatory):
- Feature between ${min} and ${max} of the products above that genuinely fit this article. Discuss each one in the prose where it is relevant: what it suits and the trade-offs, using only the facts listed above.
- Immediately after the paragraph or section that discusses a product, put its marker alone on its own line, with a blank line before and after: ::product:<slug>::  (for example ::product:${products[0].slug}::).${site.contentFormat === 'HTML' ? ` In HTML, give the marker its own paragraph: <p>::product:${products[0].slug}::</p>` : ''}
- Use only slugs from the list above, each at most once. Never invent products, slugs, prices, specifications or star ratings, and do not claim anything was tested hands-on.
- Do not put markers inside lists, tables or headings, and never place them all together at the end.
`;
}

/**
 * Validate the markers the model placed: drop unknown or duplicate slugs, put
 * each marker on its own paragraph, and add a marker for a shortlisted product
 * the text names but forgot to box (at the end of the section that first
 * mentions it). Returns the number of valid markers.
 */
function applySiteProducts(post, products) {
  if (!site.productCatalog || typeof post.content !== 'string') return 0;
  const allowed = new Map(products.map((p) => [p.slug, p]));
  const seen = new Set();
  const html = site.contentFormat === 'HTML';
  const marker = (key) => (html ? `\n<p>::product:${key}::</p>\n` : `\n\n::product:${key}::\n\n`);
  let content = post.content.replace(/(?:<p\b[^>]*>\s*)?::product:([a-z0-9-]+)::(?:\s*<\/p>)?/gi, (m, slug) => {
    const key = slug.toLowerCase();
    // Unknown, repeated, or beyond the per-article maximum.
    if (!allowed.has(key) || seen.has(key) || seen.size >= site.productCatalog.max) return '';
    seen.add(key);
    return marker(key);
  });

  // Products named in the text but not boxed: insert after the section that first names them.
  for (const p of products) {
    if (seen.size >= site.productCatalog.max) break;
    if (seen.has(p.slug)) continue;
    const names = [p.brand ? `${p.brand} ${p.name}` : '', p.name].filter((n) => n && n.length > 4);
    const idx = names.map((n) => content.toLowerCase().indexOf(n.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (idx === undefined) continue;
    const nextHeading = content.slice(idx).search(html ? /<h[2-6][\s>]/i : /\n#{2,6} /);
    const at = nextHeading >= 0 ? idx + nextHeading : content.length;
    content = `${content.slice(0, at).replace(/\s+$/, '')}${marker(p.slug)}${content.slice(at).replace(/^\s+/, '')}`;
    seen.add(p.slug);
  }

  post.content = content.replace(/\n{3,}/g, '\n\n').trim();
  post.productSlugs = [...seen];
  return seen.size;
}


/* ---------------------------------------------------------------------------
 * "Where to buy": live affiliate retailer links (DataForSEO)
 *
 * For each catalogue product the article features, one DataForSEO Google
 * Shopping "sellers" task (keyed on the product's googleProductId, so offers
 * are for that exact product) returns current Australian retailers. The best
 * few become rel="sponsored" links in a section appended to the post. No
 * prices are printed (the site deliberately says "Check price at X" because
 * prices move). Affiliate tagging is done on the site (Geniuslink for Amazon,
 * Sovrn for the rest). Cost: ~$0.001 per product on the standard queue.
 *
 * DataForSEO was chosen over ZenRows: structured seller data for ~$0.001 a
 * product, where scraping Google Shopping through ZenRows needs premium
 * JS-rendered requests (~25 credits each) and brittle parsing.
 * ------------------------------------------------------------------------- */
const DFS_SELLERS = 'https://api.dataforseo.com/v3/merchant/google/sellers';

function dataforseoAuth() {
  let login = process.env.DATAFORSEO_LOGIN || '';
  let password = process.env.DATAFORSEO_PASSWORD || '';
  if (!password) {
    // Shared credentials live with the sourcing scripts.
    const file = process.env.DATAFORSEO_ENV_FILE || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'nxt-sourcing', '.env.local');
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*(DATAFORSEO_LOGIN|DATAFORSEO_PASSWORD)\s*=\s*(.*)\s*$/);
        if (m) {
          const v = m[2].replace(/^["']|["']$/g, '').trim();
          if (m[1] === 'DATAFORSEO_LOGIN') login = v; else password = v;
        }
      }
    } catch { /* no file */ }
  }
  if (!password) return null;
  // The password may already be the base64 "login:password" token.
  if (/^[A-Za-z0-9+/=]+$/.test(password) && password.length > 16) {
    try {
      const [l, ...rest] = Buffer.from(password, 'base64').toString('utf8').split(':');
      if (rest.length && l.includes('@')) return `Basic ${password}`;
    } catch { /* not base64 */ }
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

/** Post sellers tasks for the products, poll until done (max ~6 min). Map(slug -> items). */
async function fetchSellers(products, { location, language }) {
  const auth = dataforseoAuth();
  if (!auth) throw new Error('DataForSEO credentials not found');
  const res = await fetch(`${DFS_SELLERS}/task_post`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    // priority 2 = high-priority queue (~$0.002/product, usually under a minute);
    // on the standard queue a run sat for the full wait with nothing returned.
    body: JSON.stringify(products.map((p) => ({ product_id: String(p.googleProductId), location_code: location, language_code: language, priority: 2, tag: p.slug }))),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`sellers task_post HTTP ${res.status}`);
  const tasks = (await res.json()).tasks ?? [];
  const out = new Map();
  const pending = tasks.filter((t) => t.status_code === 20100 && t.id).map((t) => ({ id: t.id, tag: t.data?.tag }));
  const started = Date.now();
  const deadline = started + 3 * 60 * 1000;
  while (pending.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    process.stdout.write(`  affiliate: waiting for DataForSEO (${pending.length} left, ${Math.round((Date.now() - started) / 1000)}s)   \r`);
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const { id, tag } = pending[i];
      try {
        const r = await fetch(`${DFS_SELLERS}/task_get/advanced/${id}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(60_000) });
        const t = r.ok ? (await r.json()).tasks?.[0] : null;
        if (t?.status_code === 20000) { out.set(tag, t.result?.[0]?.items ?? []); pending.splice(i, 1); }
        // 40601 Task Handed / 40602 Task in Queue: still running, poll again.
        else if (t && t.status_code !== 40601 && t.status_code !== 40602) { pending.splice(i, 1); }
      } catch { /* retry next round */ }
    }
  }
  process.stdout.write('\n');
  if (pending.length) console.log(`  affiliate: ${pending.length} lookup(s) not ready after 3 min - skipped`);
  return out;
}

// Retailers readers in Australia recognise, in the order we prefer to list them.
const AU_RETAILERS = [
  ['amazon.com.au', 'Amazon AU'], ['jbhifi.com.au', 'JB Hi-Fi'], ['thegoodguys.com.au', 'The Good Guys'],
  ['harveynorman.com.au', 'Harvey Norman'], ['officeworks.com.au', 'Officeworks'], ['bunnings.com.au', 'Bunnings'],
  ['bigw.com.au', 'Big W'], ['kogan.com', 'Kogan'], ['ebay.com.au', 'eBay AU'], ['bing-lee.com.au', 'Bing Lee'],
  ['binglee.com.au', 'Bing Lee'], ['appliancesonline.com.au', 'Appliances Online'], ['myer.com.au', 'Myer'],
  ['davidjones.com', 'David Jones'], ['mwave.com.au', 'Mwave'], ['scorptec.com.au', 'Scorptec'],
];
const CONDITION_BAD = /refurb|renewed|used|pre-owned|second-hand|open box/i;

function auRetailerLinks(items, perProduct) {
  const links = [];
  const seen = new Set();
  for (const it of items) {
    const url = it?.url;
    if (!url || !/^https:\/\//.test(url)) continue;
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (CONDITION_BAD.test(String(it.product_condition ?? '')) || CONDITION_BAD.test(String(it.title ?? ''))) continue;
    const known = AU_RETAILERS.findIndex(([d]) => host === d || host.endsWith(`.${d}`));
    const isAu = known >= 0 || host.endsWith('.au');
    if (!isAu) continue; // Australian audience: no overseas storefronts.
    const name = known >= 0 ? AU_RETAILERS[known][1] : String(it.title || host).split(' - ')[0].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    links.push({ name, url, rank: known >= 0 ? known : 100 });
  }
  return links.sort((a, b) => a.rank - b.rank).slice(0, perProduct);
}


/** Append a "Where to buy" section of live retailer links for the featured products. */
/** Retailer links from a product's stored catalogue offers: in stock, cheapest first, one per merchant. */
function offerRetailerLinks(product, { perProduct, exclude }) {
  const seen = new Set();
  return (product.offers || [])
    .filter((o) => o?.productUrl && /^https:\/\//.test(o.productUrl) && o.availability !== 'out_of_stock' && o.merchant?.name)
    .filter((o) => !exclude?.test(o.merchant.slug || o.merchant.name))
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
    .filter((o) => !seen.has(o.merchant.name) && seen.add(o.merchant.name))
    .slice(0, perProduct)
    .map((o) => ({ name: o.merchant.name, url: o.productUrl }));
}

/** Put the "Where to buy" section at the end of the article, above an in-body FAQ section if there is one. */
function insertWhereToBuy(content, section) {
  // bestlooking.skin also treats "Common Questions About/On ..." headings as its FAQ (renamed "FAQs").
  const faq = content.search(/<h[23]\b[^>]*>(?:(?!<\/h[23]>)[\s\S])*(?:FAQ|Frequently\s+Asked|Common\s+Questions\s+(?:about|on)\b)(?:(?!<\/h[23]>)[\s\S])*<\/h[23]>/i);
  if (faq > 0) return `${content.slice(0, faq).trim()}\n\n${section}\n\n${content.slice(faq)}`;
  return `${content.trim()}\n\n${section}\n`;
}

async function appendAffiliateLinks(post, products) {
  if (site.productCatalog?.offerLinks && argv['affiliate-links'] !== false && typeof post.content === 'string') {
    const featured = (post.productSlugs || []).map((slug) => products.find((p) => p.slug === slug)).filter(Boolean);
    const rows = featured.map((p) => ({ p, links: offerRetailerLinks(p, site.productCatalog.offerLinks) })).filter((r) => r.links.length);
    if (!rows.length) {
      if (featured.length) console.log('  affiliate: no in-stock retailer offers for the featured products');
      return 0;
    }
    const rel = 'sponsored nofollow noopener noreferrer';
    const items = rows.map(({ p, links }) => `<li><strong>${escapeHtml(p.name)}</strong>: ${
      links.map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="${rel}">Check price at ${escapeHtml(l.name)}</a>`).join(' · ')
    }</li>`).join('\n');
    post.content = insertWhereToBuy(post.content, `<h2 id="where-to-buy">Where to buy</h2>\n\n<p>Retailers stocking the products in this guide. Prices and stock change often, so check the retailer before you buy. We may earn a commission from these links at no extra cost to you.</p>\n\n<ul class="where-to-buy">\n${items}\n</ul>`);
    const count = rows.reduce((n, r) => n + r.links.length, 0);
    console.log(`  affiliate: ${count} retailer links for ${rows.length} products (catalogue offers)`);
    return count;
  }
  const cfg = site.productCatalog?.affiliateOffers;
  if (!cfg || argv['affiliate-links'] === false || typeof post.content !== 'string') return 0;
  const featured = (post.productSlugs || []).map((slug) => products.find((p) => p.slug === slug)).filter((p) => p?.googleProductId);
  if (!featured.length) return 0;
  console.log(`  affiliate: looking up Australian retailers for ${featured.length} products (DataForSEO, up to 3 min)`);
  let sellers;
  try {
    sellers = await fetchSellers(featured, cfg);
  } catch (error) {
    console.log(`  affiliate: skipped (${error.message})`);
    return 0;
  }
  const rows = featured
    .map((p) => ({ p, links: auRetailerLinks(sellers.get(p.slug) || [], cfg.perProduct) }))
    .filter((r) => r.links.length);
  if (!rows.length) {
    console.log('  affiliate: no Australian retailers returned');
    return 0;
  }
  const rel = 'sponsored nofollow noopener noreferrer';
  const items = rows.map(({ p, links }) => `<li><strong>${escapeHtml(p.brand ? `${p.brand} ${p.name}` : p.name)}</strong>: ${
    links.map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="${rel}">Check price at ${escapeHtml(l.name)}</a>`).join(' · ')
  }</li>`).join('\n');
  post.content = `${post.content.trim()}\n\n<h2 id="where-to-buy">Where to buy</h2>\n\n<p>Retailers stocking the products in this guide. Prices and stock change often, so check the retailer before you buy. We may earn a commission from these links at no extra cost to you.</p>\n\n<ul class="where-to-buy">\n${items}\n</ul>\n`;
  const count = rows.reduce((n, r) => n + r.links.length, 0);
  console.log(`  affiliate: ${count} retailer links for ${rows.length} products`);
  return count;
}

/**
 * Move a "## Frequently Asked Questions" / "## FAQs" section (### question +
 * answer paragraphs) out of the Markdown body into post.faq, the shape of the
 * faq.item component ({ question, answer, order }). Left in the body, the site
 * shows it as plain headings instead of its FAQ block, with no FAQPage data.
 * The section ends at the next "## " heading, an HTML <h2>, or the end.
 */
function extractFaqToField(post) {
  if (!site.faqToField || typeof post.content !== 'string') return 0;
  // "## Frequently Asked Questions" / "## FAQs" / "## FAQ" (## or ###).
  const m = post.content.match(/^#{2,3}\s+(?:Frequently Asked Questions|FAQs?)\b.*$/im);
  if (!m) return 0;
  const start = m.index;
  const after = post.content.slice(start + m[0].length);
  const next = after.search(/^##\s|^<h2[\s>]/im);
  const section = next >= 0 ? after.slice(0, next) : after;
  // Questions come either as "### Question" headings or as "**Question**" lines;
  // everything up to the next question is the answer.
  const faq = [];
  let current = null;
  for (const line of section.split('\n')) {
    const q = line.match(/^###\s+(.+?)\s*$/) || line.match(/^\s*\*\*(.+?)\*\*\s*$/);
    if (q) {
      current = { question: q[1].replace(/\*\*/g, '').trim().slice(0, 300), answer: '' };
      faq.push(current);
    } else if (current) {
      current.answer += ` ${line.trim()}`;
    }
  }
  const items = faq
    .map((f) => ({ question: f.question, answer: f.answer.replace(/\s+/g, ' ').trim() }))
    .filter((f) => f.question && f.answer)
    .map((f, order) => ({ ...f, order }));
  if (!items.length) return 0;
  post.faq = items;
  post.content = `${post.content.slice(0, start).trimEnd()}\n\n${next >= 0 ? after.slice(next) : ''}`.trim();
  return items.length;
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
  if (site.productCatalog) await preloadSiteCatalog();
  const siteProducts = site.productCatalog ? pickSiteProducts(topic, category) : [];
  const siteProductsContext = siteProductContext(siteProducts);
  const contentFormat = site.contentFormat || (isSmartHomePost && primaryCatalogProduct ? 'HTML' : 'Markdown');
  const rankMathRequirements = site.simplePost ? `

Rank Math SEO requirements (mandatory before returning JSON):
- Choose exactly one primary focus keyword/keyphrase and put it first in "seoKeywords". Put related terms after it, comma-separated.
- Start "seoTitle" with the exact primary focus keyword whenever grammar allows; otherwise place it within the first half. Keep the complete SEO title at 60 characters or fewer.
- Put the exact primary focus keyword naturally in "seoDescription"; keep it at 155 characters or fewer.
- Include the primary focus keyword in "slug" and keep the slug concise (75 characters or fewer).
- Use the exact primary focus keyword in the first paragraph, in at least one H2 or H3, and naturally throughout the article. Use it at least once per roughly 250 words while keeping density at or below 2.5%; readability takes priority and keyword stuffing is forbidden.
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
${dealContext}${catalogContext}${smartHomeContext}${siteProductsContext}${internalLinkContext}${rankMathRequirements}

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
- Open the article with a direct 40-60 word answer to the question in the title, as a plain paragraph before the first heading. This is the passage search engines lift for featured snippets and AI overviews, so it must answer the question outright rather than introduce the topic.
- Close with a "## Frequently Asked Questions" section carrying 4 to 6 questions, each phrased as a question a reader would actually type, each answered in 40-90 words.
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
  const rankMathOptions = {
    requireInternalLink: argv.site === 'flightfares.one' && internalLinkContext.length > 0,
  };
  if (argv['skip-rank-math-test']) {
    console.log('  · Rank Math preflight skipped for Content Jobs; review the post in WordPress after publishing.');
  } else {
    try {
      validateRankMathPost(post, rankMathOptions);
    } catch (error) {
      if (argv.site !== 'flightfares.one' || !String(error?.message || '').startsWith('Rank Math preflight failed:')) {
        throw error;
      }
      const repaired = await repairFlightfaresRankMath(post, error.message);
      Object.assign(post, repaired);
      normalizePostForStrapi(post);
      normalizeContentForSite(post);
      post.slug = slugifyValue(post.slug || post.title);
      selectRankMathFocusKeyword(post);
      validateRankMathPost(post, rankMathOptions);
    }
  }
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

  if (site.productCatalog) {
    const placed = applySiteProducts(post, siteProducts);
    const { min } = site.productCatalog;
    console.log(`  products : ${placed} placed${placed ? ` (${post.productSlugs.join(', ')})` : ''} from ${siteProducts.length} candidates`);
    // Rule 8 unmet: never let it go live on its own; it is saved as a draft.
    post.productShortfall = site.productCatalog.requireMin !== false && placed < min;
    if (post.productShortfall) console.log(`  WARNING  : fewer than ${min} product boxes - saving as a DRAFT for review`);
    else if (placed < min) console.log(`  note     : fewer than ${min} product boxes (no close catalogue match)`);
    const faqs = extractFaqToField(post);
    if (faqs) console.log(`  faq      : ${faqs} questions moved to the FAQ field`);
    await appendAffiliateLinks(post, siteProducts);
  }
  return post;
}

function normalizeContentForSite(post) {
  if (site.contentFormat !== 'HTML') return;
  // The model sometimes double-escapes line breaks in HTML bodies; a literal
  // "\n" renders as visible text on the page (bestlooking.skin, 24 Sep 2026).
  const source = String(post.content || '').replace(/(?:\\r)?\\n/g, '\n').replace(/\\t/g, ' ').trim();
  if (!source) return;
  post.content = source;

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

async function repairFlightfaresRankMath(post, failureMessage) {
  const focusKeyword = String(post.seoKeywords || '').split(',')[0].trim();
  console.log(`  · ${failureMessage}`);
  console.log('  · Running one Rank Math SEO repair pass before saving...');

  const text = await callAI({
    system: 'You are a meticulous WordPress SEO editor. Return strict JSON only and preserve factual accuracy.',
    user: `Repair this Flightfares.one article so it passes the listed Rank Math checks.

Required primary focus keyword (use this exact phrase): ${focusKeyword}
Failed checks: ${failureMessage}

Return STRICT JSON with exactly these keys:
{
  "slug": string,
  "content": string,
  "seoTitle": string,
  "seoDescription": string,
  "seoKeywords": string
}

Rules:
- Keep the article's meaning, factual claims, HTML structure, and supplied links intact.
- Keep valid HTML and do not add an H1.
- Put the exact focus keyword first in seoKeywords.
- Put it in the SEO title, meta description, slug, first paragraph, and at least one H2 or H3.
- Use it naturally at least once per roughly 250 words, with total density no higher than 2.5%.
- Keep seoTitle at 60 characters or fewer, seoDescription at 155 or fewer, and slug at 75 or fewer.
- Preserve all existing internal links. Do not invent URLs, prices, schedules, policies, or facts.
- Return no commentary or Markdown fence.

Article to repair:
${JSON.stringify({
    slug: post.slug,
    content: post.content,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    seoKeywords: post.seoKeywords,
  })}`,
    maxTokens: Math.max(Number(maxOutputTokensEnv()) || 0, 16000),
  });

  const repaired = parseAiJson(text, { providerName: activeProviderName() });
  for (const field of ['slug', 'content', 'seoTitle', 'seoDescription', 'seoKeywords']) {
    if (!repaired?.[field]) throw new Error(`${activeProviderName()} Rank Math repair missing "${field}".`);
  }
  return repaired;
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
  if (enforceFlightfaresContentChecks && keywordDensity > 2.5) failures.push(`focus keyword density is ${keywordDensity.toFixed(1)}%; keep it at or below 2.5%`);
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

/**
 * Build image prompts locally when the model did not return them.
 *
 * `imagePrompts` is the last field in the requested JSON, so it is the first
 * thing lost when a response runs long -- and the article still parses and
 * saves, so the post lands with no cover and nothing fails. Observed on 1 of
 * the first 2 posts of a 69-post run, which at that rate is roughly ten
 * coverless articles.
 *
 * The title and postType are enough for a decorative editorial image, which is
 * all a blog cover needs to be, so there is no reason to let a missing field
 * decide whether a post gets one.
 */
function fillMissingImagePrompts(prompts, post) {
  const title = post?.title || post?.slug || 'skincare';
  const cover = prompts?.cover
    || `Editorial skincare photograph illustrating "${title}". Minimal flat lay on a clean neutral surface, soft morning daylight, muted tones, shallow depth of field, no text, no logos, shot on a 50mm lens.`;
  const gallery = Array.isArray(prompts?.gallery) ? [...prompts.gallery] : [];
  const fallbackGallery = [
    `Photorealistic close-up skincare texture related to "${title}", natural daylight, macro detail, soft shadows, no packaging, no text.`,
    `Bright minimal bathroom shelf scene related to "${title}", plain unlabelled containers in soft focus, diffused daylight, neutral tones, no text, no logos.`,
  ];
  while (gallery.length < 2) gallery.push(fallbackGallery[gallery.length] ?? fallbackGallery[0]);
  if (!prompts?.cover) console.log('  (model returned no image prompts - using generated fallbacks)');
  return { cover, gallery };
}

/**
 * Review posts get imagery that does not depict a specific product.
 *
 * A photorealistic shot of a labelled bottle beside a review reads as "we
 * photographed the thing we tested", and nobody tested anything -- the same
 * line the other sites draw when they refuse to write a star rating for a
 * device that was never handled. Decorative textures and ingredient-led stills
 * carry the page without making that claim.
 */
function constrainReviewImagePrompt(prompt, postType) {
  if (postType !== 'product-review') return prompt;
  return `${prompt}\n\nImportant: do NOT depict a branded or recognisable product, packaging, bottle with a label, or anything resembling a real retail item. Use abstract texture, raw ingredients, or plain unlabelled glassware on a clean surface instead.`;
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
  const prompts = fillMissingImagePrompts(post?.imagePrompts, post);
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
      const url = await generateImage(constrainReviewImagePrompt(prompt, post.postType), { aspect });
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

/*
 * Scheduled release (--publishedAt).
 *
 * Strapi's own publishedAt is a system field and timed publishing is a paid
 * Strapi feature, so the sites that support it read a plain `showFrom`
 * datetime instead: the post is saved Published, and the site hides it until
 * showFrom has passed (nxtsmarthome.com.au and bestlooking.skin filter on it in
 * their Strapi queries). publishDate is set to the same time so the article
 * shows its release date, not the day it was generated.
 */
let releaseBase = null;
let releaseIndex = 0;

function parseReleaseDate(raw) {
  const value = String(raw).trim();
  // No timezone given: the editors are in Perth, so read it as AWST (+08:00).
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalised = value.includes('T') || !/\d{2}:\d{2}/.test(value) ? value : value.replace(' ', 'T');
  const withTime = /T\d{2}:\d{2}/.test(normalised) ? normalised : `${normalised}T00:00`;
  const date = new Date(hasZone ? withTime : `${withTime}+08:00`);
  if (Number.isNaN(date.getTime())) fatal(`--publishedAt: cannot read "${raw}" as a date (use e.g. 2026-10-01T09:00)`);
  return date;
}

function resolveRelease() {
  if (!argv.publishedAt) {
    if (argv['publish-every']) fatal('--publish-every needs --publishedAt');
    return;
  }
  if (!site.supportsShowFrom) {
    fatal(`--publishedAt is not supported for ${argv.site}: its post type has no showFrom field. Supported: ${Object.keys(SITE_CONFIG).filter((k) => SITE_CONFIG[k].supportsShowFrom).join(', ')}`);
  }
  if (argv['publish-every'] !== undefined && !(argv['publish-every'] > 0)) fatal('--publish-every must be a positive number of hours');
  releaseBase = parseReleaseDate(argv.publishedAt);
  // A scheduled post must be Published in Strapi; showFrom does the hiding.
  argv.publish = true;
  const when = releaseBase.toLocaleString('en-AU', { timeZone: 'Australia/Perth', dateStyle: 'medium', timeStyle: 'short' });
  console.log(`Release: ${releaseBase.toISOString()} (${when} Perth)${argv['publish-every'] ? `, then every ${argv['publish-every']}h` : ''}${releaseBase < new Date() ? ' - in the past, so visible immediately' : ''}`);
}

/** Release time for the next saved article, or null when not scheduling. */
function nextReleaseAt() {
  if (!releaseBase) return null;
  const hours = argv['publish-every'] || 0;
  const at = new Date(releaseBase.getTime() + releaseIndex * hours * 3_600_000);
  releaseIndex += 1;
  return at.toISOString();
}

let siteAuthorIds;
async function pickSiteAuthor() {
  if (!site.authorSlugs?.length) return null;
  if (!siteAuthorIds) {
    const filters = site.authorSlugs.map((slug, i) => `filters[slug][$in][${i}]=${encodeURIComponent(slug)}`).join('&');
    const res = await strapi(`${site.authorEndpoint}?${filters}&fields[0]=slug`);
    siteAuthorIds = (res?.data || []).map((a) => a.documentId);
    const missing = site.authorSlugs.filter((slug) => !(res?.data || []).some((a) => a.slug === slug));
    if (missing.length) console.warn(`  authors not found in Strapi: ${missing.join(', ')}`);
    if (!siteAuthorIds.length) throw new Error(`none of the authors ${site.authorSlugs.join(', ')} exist at ${site.authorEndpoint}`);
  }
  return siteAuthorIds[Math.floor(Math.random() * siteAuthorIds.length)];
}

async function postToStrapi(post, { categoryId, coverId, galleryIds, sourceUrl } = {}) {
  const data = {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    content: post.content,
    postType: post.postType || argv['post-type'] || site.defaultPostType,
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
  if (site.faqToField && post.faq?.length) data.faq = post.faq;
  const authorId = await pickSiteAuthor();
  if (authorId) data.author = authorId;
  if (argv['amazon-tag']) data.amazonAffiliateTag = argv['amazon-tag'];
  // A post missing its required product boxes is held back as a draft.
  const publish = argv.publish && !post.productShortfall;
  if (publish) data.publishedAt = new Date().toISOString();
  const releaseAt = nextReleaseAt();
  if (releaseAt) {
    data.showFrom = releaseAt;
    // Only nxtsmarthome-post has a publishDate field; bls-post rejects it.
    if (site.hasPublishDate) data.publishDate = releaseAt;
  }

  /*
   * Strapi 5 publishes on create unless told otherwise.
   *
   * Under v4, omitting publishedAt meant "draft", which is the assumption this
   * tool was written on and still prints ("saved draft: <slug>"). Under v5 a
   * document has separate draft and published versions and a plain POST writes
   * BOTH, so every run without --publish has been going live while reporting a
   * draft. Five bestlooking.skin posts reached the public site that way.
   *
   * `status=draft` creates the draft version only. There is no unpublish in the
   * Content API, so the ones already live had to be cleared out of Postgres --
   * worth avoiding a second time.
   */
  const createPath = publish
    ? site.postEndpoint
    : `${site.postEndpoint}${site.postEndpoint.includes('?') ? '&' : '?'}status=draft`;

  return strapi(createPath, {
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
    } else if (parts.length >= 3 && SITE_CONFIG[parts[0]]) {
      const [rowSite, category, ...topicParts] = parts;
      if (rowSite === argv.site) {
        jobs.push(await enrichJobWithProductSeed({ category, topic: topicParts.join(' | ') }));
      }
    } else if (parts.length === 4 && !SITE_CONFIG[parts[0]]) {
      /* "category | title | slug | postType" -- a planned row carrying its
       * format. Without it every post takes site.defaultPostType, which for
       * this site is product-review: the first run filed a how-to and two
       * comparisons under Product Reviews, and the storefront buckets its
       * article nav by exactly this field. */
      const [category, title, slug, postType] = parts;
      jobs.push(await enrichJobWithProductSeed({ category, topic: title, forcedTitle: title, forcedSlug: slug, forcedPostType: postType }));
    } else if (parts.length === 3) {
      /*
       * "category | title | slug" -- a planned row. A content plan fixes both
       * the title and the slug (they are chosen against search data and linked
       * from the plan doc), so neither is left to the model. Without this the
       * writer rephrased "Best Sunscreens for Oily Skin in 2026" into its own
       * title and derived a slug carrying the year, which the plan explicitly
       * forbids.
       */
      const [category, title, slug] = parts;
      jobs.push(await enrichJobWithProductSeed({ category, topic: title, forcedTitle: title, forcedSlug: slug }));
    } else {
      jobs.push(await enrichJobWithProductSeed({ category: argv.category, topic: row }));
    }
  }

  // Rows already written (draft or published) are skipped, so a daily
  // "--topics file --count 1" run takes the next unwritten row each time.
  const existing = await loadExistingPostKeys();
  const keyOf = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const fresh = jobs.filter((job) => {
    const slug = job.forcedSlug ? slugifyValue(job.forcedSlug) : '';
    const title = keyOf(job.forcedTitle || job.topic);
    return !(slug && existing.slugs.has(slug)) && !(title && existing.titles.has(title));
  });
  if (fresh.length < jobs.length) console.log(`Topics: ${jobs.length - fresh.length} already in Strapi skipped, ${fresh.length} left`);
  return argv.count ? fresh.slice(0, argv.count) : fresh;
}

/** Slugs and normalised titles of every post in this site's collection, draft and published. */
async function loadExistingPostKeys() {
  const slugs = new Set();
  const titles = new Set();
  const sep = site.postEndpoint.includes('?') ? '&' : '?';
  for (const status of ['draft', 'published']) {
    for (let page = 1; page <= 100; page += 1) {
      const res = await strapi(`${site.postEndpoint}${sep}status=${status}&fields[0]=slug&fields[1]=title&pagination[page]=${page}&pagination[pageSize]=100`);
      for (const p of res?.data || []) {
        if (p.slug) slugs.add(p.slug);
        if (p.title) titles.add(String(p.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
      }
      if (page >= (res?.meta?.pagination?.pageCount || 1)) break;
    }
  }
  return { slugs, titles };
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

    // A planned title, slug and format win over whatever the model returned.
    if (job.forcedTitle) post.title = job.forcedTitle;
    if (job.forcedSlug) post.slug = job.forcedSlug;
    if (job.forcedPostType) post.postType = job.forcedPostType;

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
        // fal.ai errors say only "Forbidden"; the reason (e.g. "User is locked.
        // Reason: Exhausted balance") is in error.body.detail.
        const detail = error?.body?.detail ? `: ${typeof error.body.detail === 'string' ? error.body.detail : JSON.stringify(error.body.detail)}` : '';
        console.log(`  image step failed (${`${error.message}${detail}`.slice(0, 240)}) - saving post without images`);
        console.log('  add a cover later with: node add-cover.mjs <slug>');
      }
    }

    if (galleryAssets.length) {
      const before = post.content;
      post.content = insertFlightfaresInlineImages(post.content, post, galleryAssets);
      /*
       * Only claim the embed when it happened. insertFlightfaresInlineImages
       * returns early for every site except flightfares.one, but this line used
       * to print regardless -- so a 68-post run reported "embedded 2 contextual
       * image(s)" 67 times while placing none, and the posts looked correct in
       * the log while showing only their cover on the page.
       */
      if (post.content !== before) {
        console.log(`  embedded ${galleryAssets.length} contextual image(s) in the article body`);
      } else {
        console.log(`  ${galleryAssets.length} gallery image(s) attached (rendered from the gallery field, not embedded)`);
      }
    }

    const saved = await postToStrapi(post, {
      categoryId,
      coverId,
      galleryIds,
      sourceUrl: job.catalogProducts?.[0]?.productUrl || job.dealProduct?.url || null,
    });
    const id = saved?.data?.documentId || saved?.data?.id;
    const adminUrl = `${STRAPI_URL}/admin/content-manager/collection-types/${site.adminUid}/${id}`;
    const showFrom = saved?.data?.showFrom;
    const savedPublished = argv.publish && !post.productShortfall;
    console.log(`  saved ${savedPublished ? 'published' : 'draft'}: ${post.slug}${showFrom ? ` · shows from ${showFrom}` : ''}${coverId ? ` · cover=${coverId}` : ''}${galleryIds.length ? ` · gallery=[${galleryIds.join(',')}]` : ''}`);
    console.log(`  review: ${adminUrl}\n`);
    results.push({ topic: job.topic, slug: post.slug, id, status: !savedPublished ? 'draft' : showFrom ? `scheduled ${showFrom}` : 'published' });
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
