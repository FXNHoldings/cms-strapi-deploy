#!/usr/bin/env node
// Generate NXT.Bargains articles (Best Sellers, Product Reviews, Comparisons, Smart Home, Guides, etc.) with AI and upload to Strapi.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { fal } from '@fal-ai/client';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { input, select } from '@inquirer/prompts';
import { parseAiJson } from './parse-ai-json.js';
import { PROMPT_STYLES, PROMPT_STYLE_KEYS, EDITORIAL_NOTES_SCHEMA } from './prompt-styles.js';

const NXT_CATEGORIES = [
  { slug: 'best-sellers-articles', name: 'Best Sellers' },
  { slug: 'product-comparisons', name: 'Product Comparisons' },
  { slug: 'product-reviews', name: 'Product Reviews' },
  { slug: 'product-roundups', name: 'Product Roundups' },
  { slug: 'how-to-guides', name: 'How-to Guides' },
  { slug: 'buying-guides', name: 'Buying Guides' },
  { slug: 'top-rated-smart-electronics-devices', name: 'Top-Rated Products' },
  { slug: 'nxt-bargains-informative-articles', name: 'Informative Articles' },
  { slug: 'smart-home', name: 'Smart Home' },
];

const CATEGORY_PRODUCT_MAP = {
  'smart-home': [
    'smart-home',
    'smart-home-automation',
    'smart-home-devices',
    'smart-home-security',
    'smart-home-entertainment',
    'smart-light-bulbs',
    'smart-plugs',
    'smart-cameras',
    'video-doorbells',
    'smart-door-locks',
    'smart-speakers',
    'robot-vacuums',
    'raspberry-pi',
    'hubs-platforms',
    'climate-comfort',
    'lighting',
    'security-cameras',
  ],
};

const LENGTH_PROMPTS = {
  short: { label: 'Short (~800 - 1,000 words)', minWords: 800, text: 'approx 800–1000 words' },
  medium: { label: 'Medium (~1,200 - 1,500 words)', minWords: 1200, text: 'approx 1200–1500 words' },
  long: { label: 'Long (~1,800 - 2,500+ words)', minWords: 1800, text: 'approx 1800–2500 words' },
};

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options] [topic]')
  .option('category', {
    alias: 'c',
    type: 'string',
    describe: 'NXT.Bargains article category slug (e.g. best-sellers-articles, smart-home, product-reviews). Prompts when omitted.',
  })
  .option('commerce-category', {
    alias: 'cc',
    type: 'string',
    describe: 'Commerce product category slug (e.g. smart-phones, laptops, smart-home, tablets, smartwatches, raspberry-pi).',
  })
  .option('prompt-style', {
    alias: 'style',
    type: 'string',
    choices: PROMPT_STYLE_KEYS,
    describe: 'Article writing style method. Prompts when omitted.',
  })
  .option('length', {
    alias: 'l',
    type: 'string',
    choices: ['short', 'medium', 'long'],
    describe: 'Article target length (short, medium, long). Prompts when omitted.',
  })
  .option('product-source', {
    alias: 'ps',
    type: 'string',
    choices: ['catalog', 'best-sellers', 'dataforseo', 'auto', 'none'],
    describe: 'Product source (catalog = https://nxt.bargains/all-products, best-sellers, dataforseo = Google Shopping, auto, none). Prompts when omitted.',
  })
  .option('product', {
    alias: 'p',
    type: 'string',
    describe: 'Product title, slug, or search term from NXT.Bargains products.',
  })
  .option('image-type', {
    alias: 'image',
    type: 'string',
    choices: ['product', 'ai', 'none'],
    describe: 'Featured image source (product, ai, none). Prompts when omitted.',
  })
  .option('topic', {
    alias: 't',
    type: 'string',
    describe: 'Article topic or product title.',
  })
  .option('count', {
    alias: 'n',
    type: 'number',
    describe: 'How many posts to generate. Prompts when omitted.',
  })
  .option('merchant', {
    alias: 'm',
    type: 'string',
    choices: ['all', 'amazon', 'ebay', 'walmart', 'target', 'newegg'],
    describe: 'Merchant filter for Best Sellers products.',
  })
  .option('min-words', {
    type: 'number',
    describe: 'Minimum article body word count (overrides length selection).',
  })
  .option('publish', {
    type: 'boolean',
    default: false,
    describe: 'Publish immediately; default is draft',
  })
  .option('dry-run', {
    type: 'boolean',
    default: false,
    describe: 'Generate and print JSON only; do not write to Strapi',
  })
  .option('provider', {
    alias: 'ai-provider',
    type: 'string',
    choices: ['gemini', 'google', 'anthropic', 'openai', 'openrouter'],
    describe: 'AI provider for article generation (gemini, anthropic, openai, openrouter).',
  })
  .option('model', {
    alias: 'm-model',
    type: 'string',
    describe: 'AI model override (e.g. gemini-2.5-flash, gemini-2.5-pro, claude-sonnet-4-6, gpt-5.5).',
  })
  .option('suggest-title', {
    alias: ['suggest-topic', 'suggest'],
    type: 'boolean',
    default: false,
    describe: 'Auto-suggest article titles using AI based on category and previous blog posts',
  })
  .option('auto-title', {
    type: 'boolean',
    default: false,
    describe: 'Automatically pick top AI-suggested title without interactive prompt',
  })
  .help()
  .parseSync();

const positionalTopic = argv._[0];
if (!argv.topic && positionalTopic) argv.topic = String(positionalTopic);

function getArgCategory() {
  return argv.category || argv.c || null;
}
function getArgCommerceCategory() {
  return argv['commerce-category'] || argv.commerceCategory || argv.cc || null;
}
function getArgStyle() {
  return argv['prompt-style'] || argv.promptStyle || argv.style || null;
}
function getArgLength() {
  return argv.length || argv.l || null;
}
function getArgProductSource() {
  return argv['product-source'] || argv.productSource || argv.ps || null;
}
function getArgProduct() {
  return argv.product || argv.p || null;
}
function getArgImageType() {
  return argv['image-type'] || argv.imageType || argv.image || null;
}
function getArgDryRun() {
  return Boolean(argv['dry-run'] || argv.dryRun);
}
function getArgPublish() {
  return Boolean(argv.publish);
}
function getArgSuggestTitle() {
  return Boolean(argv['suggest-title'] || argv.suggestTitle || argv['suggest-topic'] || argv.suggestTopic);
}
function getArgAutoTitle() {
  return Boolean(argv['auto-title'] || argv.autoTitle);
}
function getArgProvider() {
  return argv.provider || argv['ai-provider'] || null;
}
function getArgModel() {
  return argv.model || null;
}

const {
  AI_PROVIDER = 'anthropic',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-5.5',
  OPENAI_MAX_OUTPUT_TOKENS = '16000',
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = '~openai/gpt-latest',
  OPENROUTER_MAX_TOKENS = '16000',
  OPENROUTER_SITE_URL = 'https://nxt.bargains',
  OPENROUTER_APP_NAME = 'NXT.Bargains AI Writer CLI',
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  CLAUDE_MAX_TOKENS = '4096',
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-3.6-flash',
  GEMINI_MAX_TOKENS = '16000',
  STRAPI_URL = 'http://127.0.0.1:8888',
  STRAPI_API_TOKEN,
  FAL_KEY,
} = process.env;

const rawProvider = (getArgProvider() || AI_PROVIDER).toLowerCase();
const aiProvider = rawProvider === 'google' ? 'gemini' : rawProvider;
if (!['gemini', 'openai', 'openrouter', 'anthropic'].includes(aiProvider)) fatal('AI_PROVIDER must be "gemini", "openai", "openrouter", or "anthropic".');
if (aiProvider === 'gemini' && !GEMINI_API_KEY) fatal('GEMINI_API_KEY is not set in environment or .env file.');
if (aiProvider === 'openai' && !OPENAI_API_KEY) fatal('OPENAI_API_KEY is not set.');
if (aiProvider === 'openrouter' && !OPENROUTER_API_KEY) fatal('OPENROUTER_API_KEY is not set.');
if (aiProvider === 'anthropic' && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set.');
if (!getArgDryRun()) {
  if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
}

const googleGenAIClient = aiProvider === 'gemini' ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const anthropicClient = aiProvider === 'anthropic' ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const openaiClient = aiProvider === 'openai' ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const openrouterClient = aiProvider === 'openrouter'
  ? new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
  : null;

if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const BEST_SELLERS_DIR = '/var/www/html/nxt.bargains/data';
const ADMIN_UID = 'api::nxt-post.nxt-post';
const MARKETPLACES = [
  { key: 'newegg', label: 'Newegg', sourcePage: 'https://nxt.bargains/best-sellers/newegg', file: 'best-sellers-newegg.json' },
  { key: 'amazon', label: 'Amazon', sourcePage: 'https://nxt.bargains/best-sellers/amazon', file: 'best-sellers.json' },
  { key: 'ebay', label: 'eBay', sourcePage: 'https://nxt.bargains/best-sellers/ebay', file: 'best-sellers-ebay.json' },
  { key: 'walmart', label: 'Walmart', sourcePage: 'https://nxt.bargains/best-sellers/walmart', file: 'best-sellers-walmart.json' },
  { key: 'target', label: 'Target', sourcePage: 'https://nxt.bargains/best-sellers/target', file: 'best-sellers-target.json' },
];
const PRODUCT_CAROUSEL_LIMIT = 8;

async function promptForMissingOptions() {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;

  // 1. Category prompt
  if (!getArgCategory()) {
    if (isTTY) {
      const chosenCategory = await select({
        message: 'Select NXT.Bargains article category:',
        choices: [
          ...NXT_CATEGORIES.map((cat) => ({
            name: `${cat.name} (${cat.slug})`,
            value: cat.slug,
          })),
          { name: 'Custom category (enter slug/name)...', value: 'custom' },
        ],
      });

      if (chosenCategory === 'custom') {
        argv.category = await input({
          message: 'Enter custom category name or slug:',
          validate: (val) => (val.trim() ? true : 'Category cannot be empty.'),
        });
      } else {
        argv.category = chosenCategory;
      }
    } else {
      argv.category = 'best-sellers-articles';
    }
  }

  // 1b. CLI flag auto title suggestion
  if ((getArgSuggestTitle() || getArgAutoTitle()) && !argv.topic) {
    const suggested = await handleTitleSuggestions(getArgCategory(), isTTY);
    if (suggested) {
      argv.topic = suggested;
      if (!getArgProductSource()) argv['product-source'] = 'none';
    }
  }

  // 2. Writing Style prompt
  if (!getArgStyle()) {
    if (isTTY) {
      argv['prompt-style'] = await select({
        message: 'Select article writing style method:',
        choices: PROMPT_STYLE_KEYS.map((key) => ({
          name: PROMPT_STYLES[key].label,
          value: key,
        })),
        default: 'default',
      });
    } else {
      argv['prompt-style'] = 'default';
    }
  }

  // 3. Length prompt
  if (!getArgLength() && !argv['min-words']) {
    if (isTTY) {
      argv.length = await select({
        message: 'Select target article length:',
        choices: [
          { name: LENGTH_PROMPTS.short.label, value: 'short' },
          { name: LENGTH_PROMPTS.medium.label, value: 'medium' },
          { name: LENGTH_PROMPTS.long.label, value: 'long' },
        ],
        default: 'medium',
      });
    } else {
      argv.length = 'medium';
    }
  }

  // 4. Product Source prompt
  if (getArgCategory() === 'top-rated-smart-electronics-devices' && !getArgProductSource()) {
    argv['product-source'] = 'dataforseo';
  }

  if (!getArgProductSource()) {
    if (isTTY) {
      const defaultSource = getArgCategory() === 'best-sellers-articles' ? 'best-sellers' : 'catalog';
      argv['product-source'] = await select({
        message: 'Select product dataset source for article subject & price comparison:',
        choices: [
          { name: 'DataForSEO Google Shopping API (Real-time live prices & products)', value: 'dataforseo' },
          { name: 'NXT.Bargains product catalog (https://nxt.bargains/all-products)', value: 'catalog' },
          { name: 'Best Sellers marketplace datasets (Amazon, eBay, Walmart, etc.)', value: 'best-sellers' },
          { name: 'Auto-select best product source', value: 'auto' },
          { name: 'General topic / No specific product box', value: 'none' },
        ],
        default: defaultSource,
      });
    } else {
      argv['product-source'] = getArgCategory() === 'best-sellers-articles' ? 'best-sellers' : 'catalog';
    }
  }

  // 5. Interactive product selection from catalog (if catalog chosen & no specific product passed yet)
  if (getArgProductSource() === 'catalog' && !getArgProduct() && isTTY) {
    const commerceCategories = await fetchCommerceCategories();
    const selectionMode = await select({
      message: 'Select catalog product selection mode:',
      choices: [
        { name: '💡 Auto-suggest new article titles using AI (based on category & past posts)', value: 'suggest-title' },
        ...(commerceCategories.length > 0 ? [{ name: 'Filter catalog products by Product Category (Smartphones, Smart Home, Laptops, etc.)', value: 'by-category' }] : []),
        { name: 'Pick from current article category products list', value: 'pick' },
        { name: 'Search catalog by product keyword / brand...', value: 'search' },
        { name: 'Auto-select random catalog product(s)', value: 'auto' },
      ],
      default: 'suggest-title',
    });

    if (selectionMode === 'suggest-title') {
      const suggestedTopic = await handleTitleSuggestions(getArgCategory(), isTTY);
      if (suggestedTopic) {
        argv.topic = suggestedTopic;
        argv['product-source'] = 'none';
      } else {
        const manualTopic = await input({
          message: `Enter topic for this ${getCategoryName(getArgCategory())} article manually:`,
          validate: (val) => (val.trim() ? true : 'Topic cannot be empty.'),
        });
        argv.topic = manualTopic.trim();
        argv['product-source'] = 'none';
      }
    } else if (selectionMode === 'by-category') {
      const chosenCommerceCat = await select({
        message: 'Select Product Category:',
        choices: [
          { name: 'All Product Categories', value: 'all' },
          ...commerceCategories.map((c) => ({
            name: `${c.name} (${c.slug})`,
            value: c.slug,
          })),
        ],
      });
      if (chosenCommerceCat !== 'all') {
        argv['commerce-category'] = chosenCommerceCat;
      }
      const catProducts = await fetchCatalogProducts({ commerceCategory: getArgCommerceCategory(), categorySlug: getArgCategory(), limit: 40 });
      if (catProducts.length > 0) {
        const chosenSlug = await select({
          message: 'Select product from catalog:',
          choices: catProducts.map((p) => ({
            name: `[${p.category}] ${p.title}${p.brand ? ` — ${p.brand}` : ''}${p.price ? ` (${p.price})` : ''}`,
            value: p.slug,
          })),
        });
        argv.product = chosenSlug;
      } else {
        console.log('  · No products found in selected category; auto-selecting from catalog.');
      }
    } else if (selectionMode === 'pick') {
      const catalogProducts = await fetchCatalogProducts({ commerceCategory: getArgCommerceCategory(), categorySlug: getArgCategory(), limit: 40 });
      if (catalogProducts.length > 0) {
        const chosenSlug = await select({
          message: 'Select product from catalog:',
          choices: catalogProducts.map((p) => ({
            name: `[${p.category}] ${p.title}${p.brand ? ` — ${p.brand}` : ''}${p.price ? ` (${p.price})` : ''}`,
            value: p.slug,
          })),
        });
        argv.product = chosenSlug;
      }
    } else if (selectionMode === 'search') {
      const searchTerm = await input({
        message: 'Enter product name, brand, or keyword to search in catalog:',
        validate: (val) => (val.trim() ? true : 'Search term cannot be empty.'),
      });
      const searched = await fetchCatalogProducts({ searchTerm, limit: 20 });
      if (searched.length > 0) {
        const chosenSlug = await select({
          message: `Found ${searched.length} matching products. Select product:`,
          choices: searched.map((p) => ({
            name: `[${p.category}] ${p.title}${p.brand ? ` — ${p.brand}` : ''}${p.price ? ` (${p.price})` : ''}`,
            value: p.slug,
          })),
        });
        argv.product = chosenSlug;
      } else {
        console.log('  · No catalog products matched query; using search term as topic.');
        argv.topic = searchTerm;
      }
    }
  }

  // 6. Featured Image source prompt
  if (!getArgImageType()) {
    if (isTTY) {
      const canUseProductImg = getArgProductSource() !== 'none';
      argv['image-type'] = await select({
        message: 'Select featured cover image source:',
        choices: [
          ...(canUseProductImg ? [{ name: 'Catalog / Merchant product image', value: 'product' }] : []),
          { name: 'Generate AI cover image with Fal.ai FLUX', value: 'ai' },
          { name: 'No cover image (content text only)', value: 'none' },
        ],
        default: canUseProductImg ? 'product' : 'ai',
      });
    } else {
      argv['image-type'] = getArgProductSource() !== 'none' ? 'product' : 'ai';
    }
  }

  // 7. Count prompt
  if (argv.count === undefined) {
    if (isTTY) {
      const answer = await input({
        message: 'How many articles should I generate?',
        default: '1',
        validate: (value) => {
          const n = Number(value);
          return Number.isInteger(n) && n > 0 ? true : 'Enter a positive whole number.';
        },
      });
      argv.count = Number(answer);
    } else {
      argv.count = 1;
    }
  }

  // 8. Topic prompt (for non-product posts, DataForSEO, or Top-Rated Products)
  if (!argv.topic && !getArgProduct() && (getArgProductSource() === 'none' || getArgProductSource() === 'dataforseo' || getArgCategory() === 'top-rated-smart-electronics-devices')) {
    if (isTTY) {
      const isTopRated = getArgCategory() === 'top-rated-smart-electronics-devices';
      const topicMode = await select({
        message: `Set topic/title for this ${getCategoryName(getArgCategory())} article:`,
        choices: [
          { name: '💡 Auto-suggest article titles using AI (analyzing category & previous posts)', value: 'suggest' },
          { name: '✏️ Enter topic or title manually', value: 'manual' },
        ],
        default: 'suggest',
      });

      if (topicMode === 'suggest') {
        const suggested = await handleTitleSuggestions(getArgCategory(), isTTY);
        if (suggested) {
          argv.topic = suggested;
        } else {
          const topicInput = await input({
            message: isTopRated
              ? 'Enter product topic or keyword for Top-Rated Products (e.g. Smart Entry, Smart Door Locks):'
              : `Enter topic for this ${getCategoryName(getArgCategory())} article manually:`,
            default: isTopRated ? 'Smart Entry' : '',
          });
          if (topicInput.trim()) argv.topic = topicInput.trim();
        }
      } else {
        const topicInput = await input({
          message: isTopRated
            ? 'Enter product topic or keyword for Top-Rated Products (e.g. Smart Entry, Smart Door Locks):'
            : `Enter topic for this ${getCategoryName(getArgCategory())} article:`,
          default: isTopRated ? 'Smart Entry' : '',
        });
        if (topicInput.trim()) argv.topic = topicInput.trim();
      }
    }
  }
}

function getCategoryName(categorySlugOrName) {
  const match = NXT_CATEGORIES.find((c) => c.slug === categorySlugOrName || c.name.toLowerCase() === String(categorySlugOrName).toLowerCase());
  if (match) return match.name;
  return String(categorySlugOrName || 'General')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

function getEffectiveMinWords() {
  if (argv['min-words']) return Number(argv['min-words']);
  const lengthKey = getArgLength() || 'medium';
  return LENGTH_PROMPTS[lengthKey]?.minWords ?? 1200;
}

function getEffectiveLengthText() {
  const lengthKey = getArgLength() || 'medium';
  return LENGTH_PROMPTS[lengthKey]?.text ?? 'approx 1200–1500 words';
}

async function strapi(pathname, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (STRAPI_API_TOKEN) headers.Authorization = `Bearer ${STRAPI_API_TOKEN}`;

  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Strapi ${res.status} on ${pathname}: ${detail.slice(0, 500)}`);
  }
  return res.json();
}

async function resolveCategoryId(categorySlugOrName) {
  const slug = slugifyValue(categorySlugOrName);
  const bySlug = await strapi(`/api/nxt-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`);
  if (bySlug?.data?.[0]?.id) return bySlug.data[0].id;

  const name = getCategoryName(categorySlugOrName);
  const byName = await strapi(`/api/nxt-categories?filters[name][$eqi]=${encodeURIComponent(name)}&pagination[pageSize]=1`);
  if (byName?.data?.[0]?.id) return byName.data[0].id;

  const created = await strapi('/api/nxt-categories', {
    method: 'POST',
    body: JSON.stringify({ data: { name, slug } }),
  });
  return created.data.id;
}

async function fetchCommerceCategories() {
  try {
    const res = await strapi('/api/commerce-categories?pagination[pageSize]=100&sort[0]=name:asc');
    const items = Array.isArray(res?.data) ? res.data : [];
    return items.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
    }));
  } catch {
    return [];
  }
}

async function fetchCatalogProducts(opts = {}) {
  const { categorySlug = null, commerceCategory = null, searchTerm = null, limit = 50 } = opts;

  let queryParams = `pagination[pageSize]=${limit}&populate=*&sort[0]=updatedAt:desc`;
  const filters = [];

  if (searchTerm) {
    filters.push(`filters[$or][0][name][$containsi]=${encodeURIComponent(searchTerm)}`);
    filters.push(`filters[$or][1][brand][$containsi]=${encodeURIComponent(searchTerm)}`);
    filters.push(`filters[$or][2][slug][$containsi]=${encodeURIComponent(searchTerm)}`);
  } else if (commerceCategory) {
    filters.push(`filters[$or][0][categories][slug][$eqi]=${encodeURIComponent(commerceCategory)}`);
    filters.push(`filters[$or][1][categories][name][$eqi]=${encodeURIComponent(commerceCategory)}`);
    filters.push(`filters[$or][2][category][$eqi]=${encodeURIComponent(commerceCategory)}`);
  } else if (categorySlug && categorySlug !== 'best-sellers-articles' && categorySlug !== 'all') {
    const related = CATEGORY_PRODUCT_MAP[categorySlug] || [categorySlug];
    related.forEach((slug, idx) => {
      filters.push(`filters[$or][${idx}][categories][slug][$eqi]=${encodeURIComponent(slug)}`);
    });
    filters.push(`filters[$or][${related.length}][category][$containsi]=${encodeURIComponent(getCategoryName(categorySlug))}`);
  }

  if (filters.length > 0) {
    queryParams += `&${filters.join('&')}`;
  }

  try {
    const res = await strapi(`/api/commerce-products?${queryParams}`);
    let items = Array.isArray(res?.data) ? res.data : [];

    // Fallback: if filtering yielded 0 items, fetch general active catalog products
    if (!items.length && (categorySlug || searchTerm || commerceCategory)) {
      const fallbackRes = await strapi(`/api/commerce-products?pagination[pageSize]=${limit}&populate=*&sort[0]=updatedAt:desc`);
      items = Array.isArray(fallbackRes?.data) ? fallbackRes.data : [];
    }

    return items.map((item) => {
      const offers = Array.isArray(item.offers) ? item.offers : [];
      const prices = offers.map((o) => Number(o.price)).filter((p) => !isNaN(p) && p > 0);
      const minPrice = prices.length ? Math.min(...prices) : null;
      const firstImg = item.imageUrl || item.image || item.featuredImage || (Array.isArray(item.images) ? item.images[0]?.url : null);
      const categoryName = item.category || item.categories?.[0]?.name || 'General';

      return {
        source: 'catalog',
        id: item.id,
        documentId: item.documentId,
        title: item.name || item.title || 'Product',
        name: item.name,
        slug: item.slug,
        brand: item.brand,
        category: categoryName,
        description: item.shortDescription || item.description,
        image: firstImg,
        url: `https://nxt.bargains/products/${item.slug}`,
        sourcePage: `https://nxt.bargains/all-products`,
        offers,
        minPrice,
        price: minPrice ? `$${minPrice.toFixed(2)}` : null,
      };
    });
  } catch (error) {
    console.warn(`  · Could not fetch products from Strapi catalog: ${error.message.slice(0, 100)}`);
    return [];
  }
}

async function fetchPreviousPostTitles(categorySlug = null, limit = 20) {
  try {
    let endpoint = `/api/nxt-posts?pagination[pageSize]=${limit}&sort[0]=createdAt:desc&fields[0]=title&fields[1]=slug`;
    if (categorySlug) {
      endpoint += `&filters[categories][slug][$eqi]=${encodeURIComponent(categorySlug)}`;
    }
    const res = await strapi(endpoint);
    const items = Array.isArray(res?.data) ? res.data : [];
    const titles = items
      .map((item) => item?.title || item?.attributes?.title)
      .filter(Boolean);

    if (titles.length === 0 && categorySlug) {
      return fetchPreviousPostTitles(null, limit);
    }
    return titles;
  } catch {
    return [];
  }
}

function extractJsonArray(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // ignore
    }
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function suggestArticleTitles({ categorySlug, categoryName, previousTitles = [], count = 5 }) {
  const catName = categoryName || getCategoryName(categorySlug);
  const prevListText = previousTitles.length > 0
    ? `Here are recent article titles previously published in this category:\n${previousTitles.map((t) => `- ${t}`).join('\n')}`
    : 'No previous articles published in this category yet.';

  const system = `You are an expert e-commerce content strategist and lead editor for NXT.Bargains (${catName}). Return ONLY a JSON array of title strings.`;
  const user = `Generate ${count} distinct, highly click-worthy, SEO-optimized blog/article titles for the category "${catName}".

${prevListText}

Guidelines:
- Ensure titles are engaging, fresh, and relevant to modern tech, bargain shopping, buying guides, or smart device trends.
- DO NOT repeat or closely copy any of the previous article titles listed above.
- Provide diverse title angles (e.g. buying guides, best seller roundups, comparison face-offs, feature deep dives).
- Output valid JSON array only. Example: ["Title 1", "Title 2", "Title 3", "Title 4", "Title 5"]`;

  try {
    const raw = await callAI({ system, user, maxTokens: 1000 });
    const parsed = extractJsonArray(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((t) => String(t).trim()).filter(Boolean);
    }
    const lines = raw
      .split('\n')
      .map((l) => l.replace(/^[\d\s\-\*\•"\']+|["\']+$/g, '').trim())
      .filter((l) => l.length > 8);
    return lines.slice(0, count);
  } catch (err) {
    console.error('  · Failed to generate title suggestions:', err.message);
    return [];
  }
}

async function handleTitleSuggestions(categorySlug, isTTY = true) {
  const catName = getCategoryName(categorySlug);
  console.log(`\n  🔍 Fetching previous article titles for category "${catName}"...`);
  const prevTitles = await fetchPreviousPostTitles(categorySlug, 20);
  if (prevTitles.length > 0) {
    console.log(`  · Found ${prevTitles.length} recent title(s) in Strapi:`);
    prevTitles.slice(0, 5).forEach((t) => console.log(`    - "${t}"`));
    if (prevTitles.length > 5) console.log(`    ... and ${prevTitles.length - 5} more.`);
  } else {
    console.log(`  · No previous titles found in category "${catName}".`);
  }

  console.log(`  🤖 Generating smart title suggestions using ${activeProviderName()} (${activeModel()})...`);
  const suggestions = await suggestArticleTitles({ categorySlug, categoryName: catName, previousTitles: prevTitles, count: 6 });

  if (suggestions.length === 0) {
    console.log('  ⚠ Could not generate title suggestions automatically.');
    return null;
  }

  if (getArgAutoTitle() || !isTTY) {
    console.log(`  ✔ Auto-selected title: "${suggestions[0]}"\n`);
    return suggestions[0];
  }

  const chosenTitle = await select({
    message: `Select an AI-suggested article title for "${catName}":`,
    choices: [
      ...suggestions.map((t, idx) => ({
        name: `${idx + 1}. ${t}`,
        value: t,
      })),
      { name: '🔄 Regenerate title suggestions...', value: '__regenerate__' },
      { name: '✏️ Enter custom article title manually...', value: '__custom__' },
    ],
  });

  if (chosenTitle === '__regenerate__') {
    return handleTitleSuggestions(categorySlug, isTTY);
  }
  if (chosenTitle === '__custom__') {
    return input({
      message: 'Enter custom article title:',
      validate: (val) => (val.trim() ? true : 'Title cannot be empty.'),
    });
  }

  return chosenTitle;
}

function loadBestSellerProducts() {
  const products = [];
  const allowedMerchant = argv.merchant ? String(argv.merchant).toLowerCase() : null;

  for (const marketplace of MARKETPLACES) {
    if (allowedMerchant && marketplace.key !== allowedMerchant) continue;
    const filePath = path.join(BEST_SELLERS_DIR, marketplace.file);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      for (const item of items) {
        if (!item?.title || !item?.url) continue;
        products.push({
          source: 'best-sellers',
          marketplace: marketplace.label,
          marketplaceKey: marketplace.key,
          sourcePage: marketplace.sourcePage,
          rank: item.rank ?? null,
          title: String(item.title).trim(),
          price: item.price ?? null,
          priceValue: item.priceValue ?? null,
          image: item.image ?? null,
          rating: item.rating ?? null,
          ratingCount: item.ratingCount ?? null,
          url: item.url,
        });
      }
    } catch {
      // Ignore unparseable JSON files
    }
  }

  return products;
}

function loadDataForSeoCredentials() {
  if (process.env.DATAFORSEO_PASSWORD) return process.env.DATAFORSEO_PASSWORD;
  const envLocalPath = '/opt/projects/nxt.bargains/.env.local';
  if (fs.existsSync(envLocalPath)) {
    const content = fs.readFileSync(envLocalPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return process.env.DATAFORSEO_PASSWORD;
}

async function fetchDataForSeoGoogleShopping(keyword, limit = 10) {
  const basicAuth = loadDataForSeoCredentials();
  if (!basicAuth) {
    console.warn('  · DATAFORSEO_PASSWORD is not set in environment or .env.local; skipping DataForSEO fetch');
    return [];
  }

  const searchKeyword = String(keyword || 'smart entry').trim();
  console.log(`  · Fetching DataForSEO real Amazon products for keyword: "${searchKeyword}"...`);

  const headers = {
    Authorization: `Basic ${basicAuth}`,
    'Content-Type': 'application/json',
  };

  const extracted = [];
  const tag = process.env.AMAZON_AFFILIATE_TAG || 'unitradeco-20';

  try {
    const postRes = await fetch('https://api.dataforseo.com/v3/merchant/google/products/task_post', {
      method: 'POST',
      headers,
      body: JSON.stringify([
        {
          keyword: searchKeyword,
          location_code: 2840,
          language_code: 'en',
          depth: Math.min(limit * 3, 60),
        },
      ]),
    });

    if (postRes.ok) {
      const postData = await postRes.json();
      const taskId = postData.tasks?.[0]?.id;
      if (taskId) {
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise((r) => setTimeout(r, 2000));
          const getRes = await fetch(`https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced/${taskId}`, { headers });
          if (!getRes.ok) continue;

          const getData = await getRes.json();
          const task = getData.tasks?.[0];
          if (task && task.status_code === 20000) {
            const rawItems = task.result?.[0]?.items || [];
            for (const item of rawItems) {
              const offers = item.type === 'google_shopping_carousel' && Array.isArray(item.items) ? item.items : [item];
              for (const sub of offers) {
                if (sub.title && (sub.price || sub.seller)) {
                  let rawUrl = sub.shopping_url || sub.url || `https://www.amazon.com/s?k=${encodeURIComponent(sub.title)}`;
                  if (!rawUrl.includes('tag=') && rawUrl.includes('amazon.com')) {
                    rawUrl += (rawUrl.includes('?') ? '&' : '?') + `tag=${tag}`;
                  }
                  extracted.push({
                    source: 'dataforseo-google-shopping',
                    title: sub.title,
                    seller: sub.seller || 'Amazon',
                    price: sub.price ? `$${Number(sub.price).toFixed(2)}` : 'Check Price on Amazon',
                    priceValue: Number(sub.price) || null,
                    rating: sub.product_rating?.value || sub.rating || 4.5,
                    ratingCount: sub.product_rating?.votes_count || sub.reviews_count || 150,
                    url: rawUrl,
                    image: sub.product_images?.[0] || sub.product_image || sub.image_url || null,
                    tags: sub.tags || [],
                  });
                }
              }
            }
            break;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`  · DataForSEO Google Shopping fetch warning: ${err.message}`);
  }

  // If Google Shopping yielded fewer than limit items, fetch real Amazon listings via DataForSEO Organic SERP
  if (extracted.length < limit) {
    try {
      const orgRes = await fetch('https://api.dataforseo.com/v3/serp/google/organic/task_post', {
        method: 'POST',
        headers,
        body: JSON.stringify([
          {
            keyword: `${searchKeyword} site:amazon.com`,
            location_code: 2840,
            language_code: 'en',
            depth: 20,
          },
        ]),
      });

      if (orgRes.ok) {
        const orgData = await orgRes.json();
        const orgTaskId = orgData.tasks?.[0]?.id;
        if (orgTaskId) {
          for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise((r) => setTimeout(r, 2000));
            const getRes = await fetch(`https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${orgTaskId}`, { headers });
            if (!getRes.ok) continue;

            const getData = await getRes.json();
            const task = getData.tasks?.[0];
            if (task && task.status_code === 20000) {
              const rawItems = task.result?.[0]?.items || [];
              for (const item of rawItems) {
                if (item.type === 'organic' && (item.url?.includes('amazon.com') || item.domain === 'www.amazon.com')) {
                  let rawUrl = item.url;
                  if (!rawUrl.includes('tag=')) {
                    rawUrl += (rawUrl.includes('?') ? '&' : '?') + `tag=${tag}`;
                  }
                  const cleanTitle = item.title?.replace(/\s*:\s*Amazon\.com.*$/i, '').replace(/ - Amazon\.com$/i, '').trim() || searchKeyword;
                  extracted.push({
                    source: 'dataforseo-amazon',
                    title: cleanTitle,
                    seller: 'Amazon',
                    price: 'Check Price on Amazon',
                    priceValue: null,
                    rating: item.rating?.value || 4.6,
                    ratingCount: item.rating?.votes_count || 280,
                    url: rawUrl,
                    image: null,
                    tags: [],
                  });
                }
              }
              break;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`  · DataForSEO Organic Amazon fetch warning: ${err.message}`);
    }
  }

  console.log(`  · DataForSEO returned ${extracted.length} real Amazon product offer(s).`);
  return extracted.slice(0, limit);
}

async function getProductsForGeneration(count = 1) {
  const source = getArgProductSource() || 'catalog';
  const targetProductArg = getArgProduct() || null;
  const categorySlug = getArgCategory();
  const isTopRatedCategory = categorySlug === 'top-rated-smart-electronics-devices';

  if (isTopRatedCategory || source === 'dataforseo') {
    const searchKeyword = argv.topic || targetProductArg || 'Smart Entry';
    const dfsProducts = await fetchDataForSeoGoogleShopping(searchKeyword, 7);
    if (dfsProducts.length > 0) {
      return Array(count).fill(dfsProducts);
    }
  }

  if (source === 'none') return [];

  // If specific product term or slug was passed:
  if (targetProductArg) {
    const catalogMatches = await fetchCatalogProducts({ commerceCategory: getArgCommerceCategory(), searchTerm: targetProductArg, limit: 10 });
    const exactCatalog = catalogMatches.find((p) => p.slug === targetProductArg || p.title.toLowerCase() === targetProductArg.toLowerCase());
    if (exactCatalog) return Array(count).fill(exactCatalog);
    if (catalogMatches.length > 0) return catalogMatches.slice(0, count);

    // Check best-sellers if not in catalog
    const allBestSellers = loadBestSellerProducts();
    const bsMatches = allBestSellers.filter((p) => p.title.toLowerCase().includes(targetProductArg.toLowerCase()));
    if (bsMatches.length > 0) return bsMatches.slice(0, count);
  }

  // If source is catalog or auto:
  if (source === 'catalog' || source === 'auto') {
    const catalogProducts = await fetchCatalogProducts({ commerceCategory: getArgCommerceCategory(), categorySlug: getArgCategory(), limit: 100 });
    if (catalogProducts.length > 0) {
      const shuffled = [...catalogProducts].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, Math.max(1, count));
    }
  }

  // Fallback to best-sellers
  const bestSellers = loadBestSellerProducts();
  if (bestSellers.length > 0) {
    const shuffled = [...bestSellers].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.max(1, count));
  }

  return [];
}

async function generateFalCoverImage(postTitle, categoryName) {
  if (!FAL_KEY) {
    console.warn('  · FAL_KEY is not set in .env; skipping AI image generation');
    return null;
  }

  const prompt = `Professional commercial photography for an article titled "${postTitle}" in category ${categoryName}. Clean modern studio lighting, high resolution, 16:9 widescreen layout, sharp focus, aesthetic tech and shopping composition, 8k resolution.`;
  console.log(`  · generating AI cover image with Fal.ai FLUX...`);
  const result = await fal.subscribe('fal-ai/flux/schnell', {
    input: {
      prompt,
      image_size: 'landscape_16_9',
    },
    logs: false,
  });

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error('Fal.ai returned no image URL');
  return imageUrl;
}

async function generatePost({ categoryName, categorySlug, product = null, topic = null }) {
  const styleKey = getArgStyle() || 'default';
  const style = PROMPT_STYLES[styleKey] ?? PROMPT_STYLES.default;
  const styleBlock = style.instructions ? `\n${style.instructions}\n` : '';
  const minWords = getEffectiveMinWords();
  const lengthText = getEffectiveLengthText();

  const isTopRatedCategory = categorySlug === 'top-rated-smart-electronics-devices' || categoryName.toLowerCase().includes('top-rated');
  const isDfsProductList = Array.isArray(product) && product[0]?.source === 'dataforseo-google-shopping';

  if (isTopRatedCategory || isDfsProductList) {
    const dfsProducts = Array.isArray(product) ? product : [];
    const topicKeyword = topic || (dfsProducts[0]?.title ? dfsProducts[0].title.split(' ')[0] : 'Smart Entry');

    const productContextLines = dfsProducts.map((p, idx) => `
Product #${idx + 1}:
- Title: ${p.title}
- Seller / Store: ${p.seller}
- Price: ${p.price}
- Rating: ${p.rating ? `${p.rating} / 5 stars (${p.ratingCount || 0} reviews)` : 'High Rating'}
- Shopping URL: ${p.url}
- Image URL: ${p.image || 'N/A'}
`).join('\n');

    const topRatedPrompt = `Write an in-depth, authoritative "Top-Rated Products" roundup article for NXT.Bargains in the category "${categoryName}" (${categorySlug}) centered on "${topicKeyword}".

Subject Products (Real-time DataForSEO Google Shopping Data):
${productContextLines || `Topic: ${topicKeyword}`}

${styleBlock}

Return STRICT JSON only matching this schema:
{
  "title": string,
  "slug": string,
  "excerpt": string,
  "content": string,
  "seoTitle": string,
  "seoDescription": string,
  "seoKeywords": string,
  "readingTimeMinutes": number${style.instructions ? ',\n' + EDITORIAL_NOTES_SCHEMA : ''}
}

Structure & Writing Rules (Must match existing NXT.Bargains Top-Rated Products layout like smart-entry):
- The article "title" must be a compelling roundup title (e.g. "Top ${dfsProducts.length || 7} Must-Have Products in the ${topicKeyword} Category").
- "excerpt": A 2-3 sentence overview introducing the top-rated picks and key functionalities.
- "content" field must be valid HTML (not Markdown).
- Start with a lead introduction paragraph summarizing the category and highlighting key features, ending with "<!--more-->".
- Provide individual product review sections for each product listed above (using <h2> or <h3> headers for each product title).
- For each product, evaluate: Key Features, Specifications, Real-world Pros & Cons (formatted as HTML <ul> bullet lists), Target Audience, and Buying Verdict.
- Include a comprehensive "Buyer's Guide & Troubleshooting FAQ" section with 3 to 5 structured questions and detailed answers (e.g., "How to choose...", "Troubleshooting common issues...", "Security & Compatibility considerations...").
- Target length: ${lengthText}. Write at least ${minWords} words in "content".
- Do not use <h4>, <h5>, or <h6> tags.
- Keep "seoDescription" under 160 characters.
- Escape all double quotes inside JSON strings as \\".
- Do not wrap response in markdown code blocks.`;

    const text = await callAI({
      system: `You are a senior tech & deals editor for NXT.Bargains specializing in Top-Rated Products roundups. Return strict JSON only.`,
      user: topRatedPrompt,
      maxTokens: Math.max(Number(maxOutputTokensEnv()) || 0, 16000),
    });

    const post = parseAiJson(text, { providerName: activeProviderName() });
    validatePost(post);

    post.title = limitText(post.title || `Top Must-Have Products in the ${topicKeyword} Category`, 255);
    post.slug = slugifyValue(post.slug || post.title);
    post.excerpt = limitText(post.excerpt, 500);
    post.seoTitle = limitText(post.seoTitle, 70);
    post.seoDescription = limitText(post.seoDescription, 160);
    post.seoKeywords = limitText(post.seoKeywords, 255);

    let htmlBody = sanitizeGeneratedHtml(post.content);
    if (dfsProducts.length > 0) {
      htmlBody = await insertProductCardsAboveHeadings(htmlBody, dfsProducts, post.title);
    }
    post.content = htmlBody;

    return post;
  }

  let subjectContext = '';
  if (product && product.source === 'catalog') {
    const offerSummary = product.offers?.length
      ? product.offers.map((o) => `  - ${o.title || o.merchant || 'Retailer'}: $${o.price} (Product URL: ${o.productUrl || o.affiliateUrl || 'N/A'})`).join('\n')
      : '  - Live price comparison available on NXT.Bargains';

    subjectContext = `Selected catalog product from NXT.Bargains (https://nxt.bargains/all-products):
- Product Name: ${product.title}
- Brand: ${product.brand || 'N/A'}
- Product Category: ${product.category || categoryName}
- Product Slug: ${product.slug}
- NXT.Bargains Page: ${product.url}
- Description summary: ${(product.description || '').slice(0, 300)}
- Retailer Offers & Prices:\n${offerSummary}`;
  } else if (product) {
    subjectContext = `Selected product for Best Sellers:
- Product title: ${product.title}
- Merchant: ${product.marketplace}
- Best-seller page: ${product.sourcePage}
- Best-seller rank: ${product.rank ?? 'not listed'}
- Listed price: ${product.price ?? 'not listed'}
- Rating: ${product.rating ?? 'not listed'}
- Rating count: ${product.ratingCount ?? 'not listed'}
- Merchant product URL: ${product.url}
- Merchant image URL: ${product.image ?? 'not listed'}`;
  } else if (topic) {
    subjectContext = `Article topic / target subject: ${topic}`;
  } else {
    subjectContext = `Brainstorm a compelling, high-intent article topic for the ${categoryName} category on NXT.Bargains.`;
  }

  const prompt = `Write an in-depth editorial article for NXT.Bargains in the category "${categoryName}" (${categorySlug}).
${subjectContext}

${styleBlock}

Return STRICT JSON only matching this schema:
{
  "title": string,
  "slug": string,
  "excerpt": string,
  "content": string,
  "seoTitle": string,
  "seoDescription": string,
  "seoKeywords": string,
  "readingTimeMinutes": number${style.instructions ? ',\n' + EDITORIAL_NOTES_SCHEMA : ''}
}

Rules:
- The article is for the NXT.Bargains category "${categoryName}".
${product ? `- The article "title" must be an engaging, SEO-optimized title centered on "${product.title}" (e.g., "${product.title} Review & Deals Guide: Is It Worth It?"). Do not omit the core product name.` : `- Create a clear, engaging H1 title suitable for ${categoryName}.`}
- The "content" field must be valid HTML (not Markdown).
- Target length: ${lengthText}. Write at least ${minWords} words in "content".
- Use structured HTML headers (<h2> and <h3> only). Break longer sections down with <h3> subheadings. Do not use <h4>, <h5>, or <h6>.
- Provide real-world buyer insight: key features, pros, cons, budget value, trade-offs, target use cases, and purchasing advice.
- Include bullet points in at least two sections (e.g. key specs, who it suits best, who should skip it, buying tips).
- Do not invent exact fake warranty details, certification numbers, or fake quotes.
- Keep "seoDescription" under 160 characters.
- Escape all double quotes inside JSON strings as \\".
- Do not wrap response in markdown code blocks.`;

  const text = await callAI({
    system: `You are a senior tech & deals editor for NXT.Bargains (${categoryName} section). Return strict JSON only.`,
    user: prompt,
    maxTokens: Math.max(Number(maxOutputTokensEnv()) || 0, 16000),
  });

  const post = parseAiJson(text, { providerName: activeProviderName() });
  validatePost(post);

  if (product) {
    post.title = limitText(post.title || product.title, 255);
  } else {
    post.title = limitText(post.title, 255);
  }
  post.slug = slugifyValue(post.slug || post.title);
  post.excerpt = limitText(post.excerpt, 500);
  post.seoTitle = limitText(post.seoTitle, 70);
  post.seoDescription = limitText(post.seoDescription, 160);
  post.seoKeywords = limitText(post.seoKeywords, 255);

  let htmlBody = sanitizeGeneratedHtml(post.content);
  if (product) {
    htmlBody = buildDealSnapshotIntro(product, htmlBody);
  }
  post.content = htmlBody;

  return post;
}

function sanitizeGeneratedHtml(html) {
  return String(html || '')
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function buildDealSnapshotIntro(product, content) {
  const card = buildProductCard(product);
  return `${card}\n${insertProductCarouselInMiddle(content, product)}`;
}

function insertProductCarouselInMiddle(html, product) {
  const content = String(html || '').trim();
  const carousel = buildProductCarousel(product);
  if (!carousel) return content;

  const paragraphMatches = [...content.matchAll(/<\/p>/gi)];
  if (!paragraphMatches.length) return `${content}\n${carousel}`;

  const middleParagraph = Math.max(3, Math.floor(paragraphMatches.length / 2));
  const targetMatch = paragraphMatches[Math.min(middleParagraph - 1, paragraphMatches.length - 1)];
  const splitAt = targetMatch.index + targetMatch[0].length;
  return `${content.slice(0, splitAt)}\n${carousel}\n${content.slice(splitAt).trimStart()}`;
}

function buildProductCarousel(product) {
  if (product.source === 'catalog') {
    return `<section class="nxt-product-carousel" data-autoslide="true" aria-label="Explore more products on NXT.Bargains">
<h3 class="nxt-product-carousel__heading">More products &amp; deals to compare on NXT.Bargains</h3>
<p class="nxt-product-carousel__meta"><a href="https://nxt.bargains/all-products" target="_blank" rel="noopener">Browse all products &amp; compare deals across stores on NXT.Bargains</a></p>
</section>`;
  }

  const marketplace = MARKETPLACES.find((item) => item.key === product.marketplaceKey);
  if (!marketplace) return '';

  const filePath = path.join(BEST_SELLERS_DIR, marketplace.file);
  if (!fs.existsSync(filePath)) return '';

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const products = (Array.isArray(parsed?.items) ? parsed.items : [])
      .filter((item) => item?.title && item?.url && item?.image && item.url !== product.url)
      .slice(0, PRODUCT_CAROUSEL_LIMIT);

    if (!products.length) return '';

    const cards = products.map((item) => `<a class="nxt-product-carousel__item" href="${escapeAttr(item.url)}" target="_blank" rel="nofollow sponsored noopener">
<span class="nxt-product-carousel__image"><img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.title)}" loading="lazy" /></span>
<span class="nxt-product-carousel__body">
<span class="nxt-product-carousel__title">${escapeHtml(item.title)}</span>
<span class="nxt-product-carousel__meta">${escapeHtml(marketplace.label)} best-seller #${escapeHtml(item.rank ?? '?')}</span>
<span class="nxt-product-carousel__price">${escapeHtml(item.price || 'Check current price')}</span>
</span>
</a>`).join('\n');

    return `<section class="nxt-product-carousel" data-autoslide="true" aria-label="More ${escapeAttr(marketplace.label)} products">
<h3 class="nxt-product-carousel__heading">More ${escapeHtml(marketplace.label)} best-seller deals to compare</h3>
<div class="nxt-product-carousel__track">
${cards}
</div>
<p class="nxt-product-carousel__meta"><a href="${escapeAttr(marketplace.sourcePage)}" target="_blank" rel="noopener">View more ${escapeHtml(marketplace.label)} best sellers on NXT.Bargains</a></p>
</section>`;
  } catch {
    return '';
  }
}

function buildProductCard(product) {
  if (product.source === 'catalog') {
    const offerCount = product.offers?.length || 0;
    const details = [
      product.brand ? `<li><strong>Brand:</strong> ${escapeHtml(product.brand)}</li>` : '',
      product.price ? `<li><strong>Current Price:</strong> ${escapeHtml(product.price)}${offerCount > 1 ? ` (compared across ${offerCount} retailers)` : ''}</li>` : '',
      product.category ? `<li><strong>Category:</strong> ${escapeHtml(product.category)}</li>` : '',
      `<li><strong>Product Page:</strong> <a href="${escapeAttr(product.url)}" target="_blank" rel="noopener">NXT.Bargains product catalog page</a></li>`,
    ].filter(Boolean).join('\n');

    return `<aside class="nxt-product-card" aria-label="Product price comparison snapshot">
${product.image ? `<a class="nxt-product-card__image" href="${escapeAttr(product.url)}" target="_blank" rel="noopener"><img src="${escapeAttr(product.image)}" alt="${escapeAttr(product.title)}" loading="lazy" /></a>` : '<div class="nxt-product-card__image" aria-hidden="true"></div>'}
<div class="nxt-product-card__details">
<p class="nxt-product-card__eyebrow">NXT.Bargains Deal Snapshot — ${escapeHtml(product.category || 'Product')}</p>
<h3>${escapeHtml(product.title)}</h3>
${details ? `<ul>${details}</ul>` : ''}
<a class="nxt-product-card__button" href="${escapeAttr(product.url)}" target="_blank" rel="noopener">Compare Prices &amp; Deals on NXT.Bargains</a>
</div>
</aside>`;
  }

  const details = [
    `<li><strong>Merchant:</strong> ${escapeHtml(product.marketplace)}</li>`,
    product.price ? `<li><strong>Price:</strong> ${escapeHtml(product.price)}</li>` : '',
    product.rank ? `<li><strong>Best-seller rank:</strong> #${escapeHtml(product.rank)}</li>` : '',
    product.rating ? `<li><strong>Rating:</strong> ${escapeHtml(product.rating)}${product.ratingCount ? ` from ${escapeHtml(product.ratingCount)} ratings` : ''}</li>` : '',
    `<li><strong>Source page:</strong> <a href="${escapeAttr(product.sourcePage)}" target="_blank" rel="noopener">NXT.Bargains ${escapeHtml(product.marketplace)} best sellers</a></li>`,
  ].filter(Boolean).join('\n');

  return `<aside class="nxt-product-card" aria-label="Deal snapshot">
${product.image ? `<a class="nxt-product-card__image" href="${escapeAttr(product.url)}" target="_blank" rel="nofollow sponsored noopener"><img src="${escapeAttr(product.image)}" alt="${escapeAttr(product.title)}" loading="lazy" /></a>` : '<div class="nxt-product-card__image" aria-hidden="true"></div>'}
<div class="nxt-product-card__details">
<p class="nxt-product-card__eyebrow">Deal Snapshot</p>
<h3>${escapeHtml(product.title)}</h3>
${details ? `<ul>${details}</ul>` : ''}
<a class="nxt-product-card__button" href="${escapeAttr(product.url)}" target="_blank" rel="nofollow sponsored noopener">View this deal at ${escapeHtml(product.marketplace)}</a>
</div>
</aside>`;
}

function buildSingleProductCardHtml(item, rank = 1) {
  const title = escapeHtml(item.title);
  const seller = escapeHtml((item.seller || 'Amazon').toUpperCase());
  const price = escapeHtml(item.price || 'Check Price on Amazon');
  const url = escapeAttr(item.url);
  const imageRaw = item.strapiImageUrl || item.image || '';
  const image = imageRaw ? escapeAttr(imageRaw.startsWith('/') ? `https://cms.fxnstudio.com${imageRaw}` : imageRaw) : '';
  const rating = item.rating ? `${item.rating} ★` : '4.5 ★';
  const reviews = item.ratingCount ? `${Number(item.ratingCount).toLocaleString()} reviews` : '150 reviews';

  return `<aside class="nxt-product-card nxt-product-card--top-rated" aria-label="Top rated product #${rank}">
${image ? `<a class="nxt-product-card__image" href="${url}" target="_blank" rel="nofollow sponsored noopener"><img src="${image}" alt="${title}" loading="lazy" /></a>` : '<div class="nxt-product-card__image" aria-hidden="true"></div>'}
<div class="nxt-product-card__details">
<p class="nxt-product-card__eyebrow">RANK #${rank} — TOP RATED IN ${seller}</p>
<h3>${title}</h3>
<ul>
  <li><strong>Seller:</strong> ${seller}</li>
  <li><strong>Price:</strong> ${price}</li>
  <li><strong>Rating:</strong> ${rating} (${reviews})</li>
</ul>
<a class="nxt-product-card__button" href="${url}" target="_blank" rel="nofollow sponsored noopener">BUY NOW ON ${seller}</a>
</div>
</aside>`;
}

function buildReadAlsoWidgetHtml() {
  const imgLighting = 'https://cms.fxnstudio.com/uploads/read_also_smart_lighting_thumb_bdbe563a22.jpg';
  const imgPlugs = 'https://cms.fxnstudio.com/uploads/read_also_smart_plugs_thumb_51e16bbe29.jpg';

  return `<section class="nxt-read-also-card my-8 p-6 bg-white border border-slate-200 rounded-2xl shadow-sm">
  <h3 class="text-xl font-bold text-slate-900 mb-5">Read Also</h3>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <a href="https://nxt.bargains/top-rated-smart-electronics-devices/top-7-smart-lighting-solutions-2024" target="_blank" class="flex-shrink-0 w-16 h-16 rounded-xl overflow-hidden bg-slate-100 block">
        <img src="${imgLighting}" alt="Top 7 Smart Lighting Solutions of 2024" class="w-full h-full object-cover" loading="lazy" />
      </a>
      <div class="flex-1 min-w-0">
        <a href="https://nxt.bargains/top-rated-smart-electronics-devices/top-7-smart-lighting-solutions-2024" target="_blank" class="text-base font-bold text-slate-900 hover:text-blue-600 transition-colors line-clamp-2 block leading-snug">Top 7 Smart Lighting Solutions of 2024</a>
        <p class="text-xs text-slate-400 mt-1 flex items-center gap-2">
          <span>August 23, 2026</span>
          <span>•</span>
          <span class="inline-flex items-center gap-1">
            <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
            0
          </span>
        </p>
      </div>
    </div>

    <div class="flex items-center gap-4 pt-3 border-t border-slate-100">
      <a href="https://nxt.bargains/top-rated-smart-electronics-devices/top-7-smart-plugs" target="_blank" class="flex-shrink-0 w-16 h-16 rounded-xl overflow-hidden bg-slate-100 block">
        <img src="${imgPlugs}" alt="Top 7 Smart Plugs to Upgrade Your Home" class="w-full h-full object-cover" loading="lazy" />
      </a>
      <div class="flex-1 min-w-0">
        <a href="https://nxt.bargains/top-rated-smart-electronics-devices/top-7-smart-plugs" target="_blank" class="text-base font-bold text-slate-900 hover:text-blue-600 transition-colors line-clamp-2 block leading-snug">Top 7 Smart Plugs to Upgrade Your Home</a>
        <p class="text-xs text-slate-400 mt-1 flex items-center gap-2">
          <span>August 23, 2026</span>
          <span>•</span>
          <span class="inline-flex items-center gap-1">
            <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
            0
          </span>
        </p>
      </div>
    </div>
  </div>
</section>`;
}

async function insertProductCardsAboveHeadings(htmlBody, dfsProducts, articleTitle = '') {
  if (!Array.isArray(dfsProducts) || !dfsProducts.length) return htmlBody;

  // Process & upload product card images to Strapi to avoid broken external hotlinks
  for (let i = 0; i < dfsProducts.length; i++) {
    const item = dfsProducts[i];
    if (item.image && (item.image.startsWith('http://') || item.image.startsWith('https://'))) {
      try {
        const cleanName = slugifyValue(item.title || `product-${i + 1}`).slice(0, 50);
        console.log(`  · Uploading product card image #${i + 1} to Strapi...`);
        const uploaded = await uploadImageToStrapi(item.image, cleanName);
        if (uploaded?.url) {
          item.strapiImageUrl = uploaded.url;
        }
      } catch (err) {
        console.warn(`  · Warning uploading product image #${i + 1}: ${err.message.slice(0, 100)}`);
      }
    }
  }

  let count = 0;
  let result = htmlBody.replace(/<h2[^>]*>(.*?)<\/h2>/gi, (fullMatch, headingText) => {
    if (headingText.toLowerCase().includes('faq') || headingText.toLowerCase().includes('buyer') || headingText.toLowerCase().includes('guide')) {
      return fullMatch;
    }
    const item = dfsProducts[count];
    if (item && count < dfsProducts.length) {
      const cardHtml = buildSingleProductCardHtml(item, count + 1);
      count += 1;

      if (count === 4) {
        const readAlsoCard = buildReadAlsoWidgetHtml();
        return `${readAlsoCard}\n\n${cardHtml}\n${fullMatch}`;
      }

      return `${cardHtml}\n${fullMatch}`;
    }
    return fullMatch;
  });

  if (count === 0) {
    result = htmlBody.replace(/<h3[^>]*>(.*?)<\/h3>/gi, (fullMatch, headingText) => {
      if (headingText.toLowerCase().includes('faq') || headingText.toLowerCase().includes('buyer') || headingText.toLowerCase().includes('guide')) {
        return fullMatch;
      }
      const item = dfsProducts[count];
      if (item && count < dfsProducts.length) {
        const cardHtml = buildSingleProductCardHtml(item, count + 1);
        count += 1;

        if (count === 4) {
          const readAlsoCard = buildReadAlsoWidgetHtml();
          return `${readAlsoCard}\n\n${cardHtml}\n${fullMatch}`;
        }

        return `${cardHtml}\n${fullMatch}`;
      }
      return fullMatch;
    });
  }

  return result;
}

async function uploadImageToStrapi(imageUrl, filename) {
  if (!imageUrl) return null;
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
    headers: STRAPI_API_TOKEN ? { Authorization: `Bearer ${STRAPI_API_TOKEN}` } : {},
    body: form,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => '');
    throw new Error(`Strapi upload ${uploadRes.status}: ${body.slice(0, 300)}`);
  }

  const uploaded = await uploadRes.json();
  const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
  return first?.id ?? null;
}

async function postToStrapi(post, product, { categoryId, coverId } = {}) {
  const data = {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    content: post.content,
    postType: 'product-comparison',
    readingTimeMinutes: post.readingTimeMinutes,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    seoKeywords: post.seoKeywords,
    source: 'ai',
    ...(product?.url ? { sourceUrl: product.url } : {}),
  };

  if (categoryId) data.categories = [categoryId];
  if (coverId) {
    data.coverImage = coverId;
    data.ogImage = coverId;
  }
  if (getArgPublish()) data.publishedAt = new Date().toISOString();

  return strapi('/api/nxt-posts', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

async function callAI({ system, user, maxTokens }) {
  if (aiProvider === 'gemini') {
    const response = await googleGenAIClient.models.generateContent({
      model: activeModel(),
      contents: user,
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
      },
    });
    return response.text?.trim() || '';
  }

  if (aiProvider === 'openai') {
    const response = await openaiClient.responses.create({
      model: activeModel(),
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
    });
    return response.output_text?.trim() || '';
  }

  if (aiProvider === 'openrouter') {
    const completion = await openrouterClient.chat.completions.create({
      model: activeModel(),
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
    model: activeModel(),
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

function limitText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength).replace(/[,\s;:.-]+$/, '');
  const lastSpace = clipped.lastIndexOf(' ');
  const shortened = lastSpace >= Math.floor(maxLength * 0.7) ? clipped.slice(0, lastSpace) : clipped;
  return shortened.replace(/\s+(and|or|to|for|with|of|in|on|at|by)$/i, '').trim();
}

function slugifyValue(value) {
  return slugify(String(value || ''), { lower: true, strict: true, trim: true });
}

function estimateReadingTime(html) {
  return Math.max(1, Math.ceil(wordCount(html) / 220));
}

function wordCount(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function activeModel() {
  if (getArgModel()) return getArgModel();
  if (aiProvider === 'gemini') return GEMINI_MODEL;
  if (aiProvider === 'openai') return OPENAI_MODEL;
  if (aiProvider === 'openrouter') return OPENROUTER_MODEL;
  return CLAUDE_MODEL;
}

function activeProviderName() {
  if (aiProvider === 'gemini') return 'Google Gemini';
  if (aiProvider === 'openai') return 'OpenAI';
  if (aiProvider === 'openrouter') return 'OpenRouter';
  return 'Claude';
}

function maxOutputTokensEnv() {
  if (aiProvider === 'gemini') return Number(GEMINI_MAX_TOKENS) || 16000;
  if (aiProvider === 'openai') return Number(OPENAI_MAX_OUTPUT_TOKENS) || 16000;
  if (aiProvider === 'openrouter') return Number(OPENROUTER_MAX_TOKENS) || 16000;
  return Number(CLAUDE_MAX_TOKENS) || 4096;
}

function fatal(message) {
  console.error('✖', message);
  process.exit(1);
}

async function run() {
  await promptForMissingOptions();

  const categorySlug = getArgCategory() || 'best-sellers-articles';
  const categoryName = getCategoryName(categorySlug);
  const count = Math.max(1, Number(argv.count) || 1);
  const styleKey = getArgStyle() || 'default';
  const lengthKey = getArgLength() || 'medium';
  const productSource = getArgProductSource() || 'catalog';
  const imageType = getArgImageType() || 'ai';
  const commerceCategory = getArgCommerceCategory() || null;

  console.log(`NXT.Bargains Article Generator`);
  console.log(`Article Category: ${categoryName} (${categorySlug}) | Style: ${styleKey} | Length: ${lengthKey} (${getEffectiveLengthText()})`);
  console.log(`Product Source: ${productSource}${commerceCategory ? ` [Filter: ${commerceCategory}]` : ''} | Image: ${imageType} | Count: ${count}`);
  console.log(`AI: ${aiProvider} (${activeModel()}) | Dry-run: ${getArgDryRun()} | Publish: ${getArgPublish()}\n`);

  const categoryId = getArgDryRun() ? null : await resolveCategoryId(categorySlug);
  const products = await getProductsForGeneration(count);
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const product = products[index] || null;
    const topic = argv.topic || (product ? product.title : null);

    console.log(`[${index + 1}/${count}] ${product ? `[${product.category || 'Product'}: ${product.title}] ` : ''}${topic || `${categoryName} post`}`);

    const post = await generatePost({ categoryName, categorySlug, product, topic });

    if (getArgDryRun()) {
      console.log(JSON.stringify({ categorySlug, categoryName, product: product ? { title: product.title, category: product.category, url: product.url, source: product.source } : null, post }, null, 2));
      results.push({ status: 'dry-run', slug: post.slug });
      continue;
    }

    let coverId = null;
    if (imageType === 'product' && product?.image) {
      try {
        console.log(`  · uploading product image (${product.image})...`);
        coverId = await uploadImageToStrapi(product.image, slugifyValue(post.title).slice(0, 60));
      } catch (error) {
        console.log(`  · product image upload failed (${error.message.slice(0, 140)})`);
      }
    } else if (imageType === 'ai') {
      try {
        const imageUrl = await generateFalCoverImage(post.title, categoryName);
        if (imageUrl) {
          coverId = await uploadImageToStrapi(imageUrl, slugifyValue(post.title).slice(0, 60));
        }
      } catch (error) {
        console.log(`  · AI cover image generation/upload failed (${error.message.slice(0, 140)})`);
      }
    }

    const saved = await postToStrapi(post, product || {}, { categoryId, coverId });
    const id = saved?.data?.documentId || saved?.data?.id;
    const adminUrl = `${STRAPI_URL}/admin/content-manager/collection-types/${ADMIN_UID}/${id}`;
    console.log(`  · saved ${getArgPublish() ? 'published' : 'draft'}: ${post.slug}${coverId ? ` (cover=${coverId})` : ''}`);
    console.log(`  · review: ${adminUrl}\n`);
    results.push({ status: getArgPublish() ? 'published' : 'draft', slug: post.slug, id });
  }

  console.log('Done.');
  for (const result of results) {
    console.log(`- ${result.status}: ${result.slug}`);
  }
}

run().catch((error) => fatal(error.message));
