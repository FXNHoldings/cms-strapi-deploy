#!/usr/bin/env node
// Generate NXT.Bargains articles (Best Sellers, Product Reviews, Comparisons, Smart Home, Guides, etc.) with AI and upload to Strapi.

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
    describe: 'NXT.Bargains category slug or name (e.g. best-sellers-articles, smart-home). Prompts when omitted.',
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
  OPENROUTER_SITE_URL = 'https://nxt.bargains',
  OPENROUTER_APP_NAME = 'NXT.Bargains AI Writer CLI',
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
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
  if (!argv.category) {
    if (isTTY) {
      const chosenCategory = await select({
        message: 'Select NXT.Bargains category:',
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

  // 2. Writing Style prompt
  if (!argv['prompt-style']) {
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
  if (!argv.length && !argv['min-words']) {
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

  // 4. Featured Image source prompt
  if (!argv['image-type']) {
    if (isTTY) {
      const isBestSellers = argv.category === 'best-sellers-articles';
      argv['image-type'] = await select({
        message: 'Select featured cover image source:',
        choices: [
          ...(isBestSellers ? [{ name: 'Merchant product image (from best-seller data)', value: 'product' }] : []),
          { name: 'Generate AI cover image with Fal.ai FLUX', value: 'ai' },
          { name: 'No cover image (content text only)', value: 'none' },
        ],
        default: isBestSellers ? 'product' : 'ai',
      });
    } else {
      argv['image-type'] = argv.category === 'best-sellers-articles' ? 'product' : 'ai';
    }
  }

  // 5. Count prompt
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

  // 6. Topic prompt (for non-best-sellers or when topic is omitted)
  if (!argv.topic && argv.category !== 'best-sellers-articles') {
    if (isTTY) {
      const topicInput = await input({
        message: `Enter topic or product title for this ${getCategoryName(argv.category)} article (or press Enter to auto-brainstorm):`,
        default: '',
      });
      if (topicInput.trim()) argv.topic = topicInput.trim();
    }
  }
}

function getCategoryName(categorySlugOrName) {
  const match = NXT_CATEGORIES.find((c) => c.slug === categorySlugOrName || c.name.toLowerCase() === String(categorySlugOrName).toLowerCase());
  if (match) return match.name;
  return String(categorySlugOrName)
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

function getEffectiveMinWords() {
  if (argv['min-words']) return Number(argv['min-words']);
  const lengthKey = argv.length || 'medium';
  return LENGTH_PROMPTS[lengthKey]?.minWords ?? 1200;
}

function getEffectiveLengthText() {
  const lengthKey = argv.length || 'medium';
  return LENGTH_PROMPTS[lengthKey]?.text ?? 'approx 1200–1500 words';
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

function loadBestSellerProducts() {
  const products = [];
  const allowedMerchant = argv.merchant ? String(argv.merchant).toLowerCase() : null;

  for (const marketplace of MARKETPLACES) {
    if (allowedMerchant && marketplace.key !== allowedMerchant) continue;
    const filePath = path.join(BEST_SELLERS_DIR, marketplace.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  · Missing ${filePath}; skipping ${marketplace.label}`);
      continue;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    for (const item of items) {
      if (!item?.title || !item?.url) continue;
      products.push({
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
  }

  return products;
}

function pickRandomBestSellerProducts(count) {
  const products = loadBestSellerProducts();
  if (!products.length) return [];
  const shuffled = [...products];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, Math.max(1, Number(count) || 1));
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
  const styleKey = argv['prompt-style'] || 'default';
  const style = PROMPT_STYLES[styleKey] ?? PROMPT_STYLES.default;
  const styleBlock = style.instructions ? `\n${style.instructions}\n` : '';
  const minWords = getEffectiveMinWords();
  const lengthText = getEffectiveLengthText();

  let subjectContext = '';
  if (product) {
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
${product ? `- The "title" field must exactly match the selected product title "${product.title}". Do not rewrite or shorten the title.` : `- Create a clear, engaging H1 title suitable for ${categoryName}.`}
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
    post.title = limitText(product.title, 255);
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
  post.readingTimeMinutes = Number(post.readingTimeMinutes) || estimateReadingTime(post.content);

  const words = wordCount(post.content);
  if (words < minWords) {
    console.warn(`  · warning: word count is ${words} (min target was ${minWords})`);
  }

  return post;
}

function sanitizeGeneratedHtml(html) {
  return String(html || '')
    .replace(/^```(?:html|json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function buildDealSnapshotIntro(product, html) {
  const content = String(html || '').trim();
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
  const marketplace = MARKETPLACES.find((item) => item.key === product.marketplaceKey);
  if (!marketplace) return '';

  const filePath = path.join(BEST_SELLERS_DIR, marketplace.file);
  if (!fs.existsSync(filePath)) return '';

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
}

function buildProductCard(product) {
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
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
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
  if (argv.publish) data.publishedAt = new Date().toISOString();

  return strapi('/api/nxt-posts', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
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
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
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

async function run() {
  await promptForMissingOptions();

  const categorySlug = argv.category || 'best-sellers-articles';
  const categoryName = getCategoryName(categorySlug);
  const count = Math.max(1, Number(argv.count) || 1);
  const styleKey = argv['prompt-style'] || 'default';
  const lengthKey = argv.length || 'medium';
  const imageType = argv['image-type'] || 'ai';

  console.log(`NXT.Bargains Article Generator`);
  console.log(`Category: ${categoryName} (${categorySlug}) | Style: ${styleKey} | Length: ${lengthKey} (${getEffectiveLengthText()}) | Image: ${imageType}`);
  console.log(`AI: ${aiProvider} (${activeModel()}) | Count: ${count} | Dry-run: ${argv['dry-run']} | Publish: ${argv.publish}\n`);

  const categoryId = argv['dry-run'] ? null : await resolveCategoryId(categorySlug);
  const results = [];

  let bestSellerProducts = [];
  if (categorySlug === 'best-sellers-articles') {
    bestSellerProducts = pickRandomBestSellerProducts(count);
  }

  for (let index = 0; index < count; index += 1) {
    const product = bestSellerProducts[index] || null;
    const topic = argv.topic || (product ? product.title : null);

    console.log(`[${index + 1}/${count}] ${product ? `${product.marketplace} #${product.rank ?? '?'} · ` : ''}${topic || `${categoryName} post`}`);

    const post = await generatePost({ categoryName, categorySlug, product, topic });

    if (argv['dry-run']) {
      console.log(JSON.stringify({ categorySlug, categoryName, post }, null, 2));
      results.push({ status: 'dry-run', slug: post.slug });
      continue;
    }

    let coverId = null;
    if (imageType === 'product' && product?.image) {
      try {
        console.log(`  · uploading merchant product image...`);
        coverId = await uploadImageToStrapi(product.image, slugifyValue(post.title).slice(0, 60));
      } catch (error) {
        console.log(`  · merchant image upload failed (${error.message.slice(0, 140)})`);
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
    console.log(`  · saved ${argv.publish ? 'published' : 'draft'}: ${post.slug}${coverId ? ` (cover=${coverId})` : ''}`);
    console.log(`  · review: ${adminUrl}\n`);
    results.push({ status: argv.publish ? 'published' : 'draft', slug: post.slug, id });
  }

  console.log('Done.');
  for (const result of results) {
    console.log(`- ${result.status}: ${result.slug}`);
  }
}

run().catch((error) => fatal(error.message));
