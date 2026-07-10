#!/usr/bin/env node
// Generate NXT.Bargains Deals posts from cached best-seller products.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { input, select } from '@inquirer/prompts';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('count', {
    alias: 'n',
    type: 'number',
    describe: 'How many random Deals posts to generate. Prompts when omitted in an interactive terminal.',
  })
  .option('merchant', {
    alias: 'm',
    type: 'string',
    choices: ['all', 'amazon', 'ebay', 'walmart', 'target', 'newegg'],
    describe: 'Merchant to use. Prompts when omitted in an interactive terminal.',
  })
  .option('min-words', {
    type: 'number',
    default: 1000,
    describe: 'Minimum article body word count',
  })
  .option('publish', {
    type: 'boolean',
    default: false,
    describe: 'Publish immediately; default is draft',
  })
  .option('images', {
    type: 'boolean',
    describe: 'Upload the selected merchant product image as cover/OG image. Prompts when omitted in an interactive terminal.',
  })
  .option('dry-run', {
    type: 'boolean',
    default: false,
    describe: 'Generate and print JSON only; do not write to Strapi',
  })
  .help()
  .parseSync();

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

const BEST_SELLERS_DIR = '/var/www/html/nxt.bargains/data';
const ADMIN_UID = 'api::nxt-post.nxt-post';
const DEALS_CATEGORY = 'deals';
const MARKETPLACES = [
  {
    key: 'newegg',
    label: 'Newegg',
    sourcePage: 'https://nxt.bargains/best-sellers/newegg',
    file: 'best-sellers-newegg.json',
  },
  {
    key: 'amazon',
    label: 'Amazon',
    sourcePage: 'https://nxt.bargains/best-sellers/amazon',
    file: 'best-sellers.json',
  },
  {
    key: 'ebay',
    label: 'eBay',
    sourcePage: 'https://nxt.bargains/best-sellers/ebay',
    file: 'best-sellers-ebay.json',
  },
  {
    key: 'walmart',
    label: 'Walmart',
    sourcePage: 'https://nxt.bargains/best-sellers/walmart',
    file: 'best-sellers-walmart.json',
  },
  {
    key: 'target',
    label: 'Target',
    sourcePage: 'https://nxt.bargains/best-sellers/target',
    file: 'best-sellers-target.json',
  },
];
const PRODUCT_CAROUSEL_LIMIT = 8;

async function promptForMissingOptions() {
  if (argv.count === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await input({
        message: 'How many Deals articles should I generate?',
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

  if (argv.merchant) {
    if (argv.merchant === 'all') argv.merchant = undefined;
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    argv.merchant = await select({
      message: 'Which merchant should this Deals article use?',
      choices: [
        { name: 'Random from all merchants', value: 'all' },
        ...MARKETPLACES.map((marketplace) => ({
          name: marketplace.label,
          value: marketplace.key,
        })),
      ],
    });

    if (argv.merchant === 'all') argv.merchant = undefined;
  }

  if (argv.images === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      argv.images = await select({
        message: 'Upload the selected merchant product image as the cover image?',
        choices: [
          { name: 'Yes, use product image', value: true },
          { name: 'No, article content image only', value: false },
        ],
      });
    } else {
      argv.images = true;
    }
  }
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

async function resolveDealsCategoryId() {
  const bySlug = await strapi('/api/nxt-categories?filters[slug][$eq]=deals&pagination[pageSize]=1');
  if (bySlug?.data?.[0]?.id) return bySlug.data[0].id;

  const byName = await strapi('/api/nxt-categories?filters[name][$eqi]=Deals&pagination[pageSize]=1');
  if (byName?.data?.[0]?.id) return byName.data[0].id;

  const created = await strapi('/api/nxt-categories', {
    method: 'POST',
    body: JSON.stringify({ data: { name: 'Deals', slug: DEALS_CATEGORY } }),
  });
  return created.data.id;
}

function loadProducts() {
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

  if (!products.length) {
    fatal(`No best-seller products found in ${BEST_SELLERS_DIR}${allowedMerchant ? ` for ${allowedMerchant}` : ''}. Refresh best sellers first.`);
  }

  return products;
}

function pickRandomProducts(count) {
  const shuffled = [...loadProducts()];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, Math.max(1, Number(count) || 1));
}

async function generatePost(product) {
  const prompt = `Write one NXT.Bargains Deals article about this randomly selected best-seller product.

Selected product:
- Product title: ${product.title}
- Merchant: ${product.marketplace}
- Best-seller page: ${product.sourcePage}
- Best-seller rank: ${product.rank ?? 'not listed'}
- Listed price: ${product.price ?? 'not listed'}
- Rating: ${product.rating ?? 'not listed'}
- Rating count: ${product.ratingCount ?? 'not listed'}
- Merchant product URL: ${product.url}
- Merchant image URL: ${product.image ?? 'not listed'}

Return STRICT JSON only:
{
  "title": string,
  "slug": string,
  "excerpt": string,
  "content": string,
  "seoTitle": string,
  "seoDescription": string,
  "seoKeywords": string,
  "readingTimeMinutes": number
}

Rules:
- The article is for the NXT.Bargains category "Deals".
- Focus on the selected product. Do not turn this into a generic buying guide.
- The "title" field must exactly match the selected product title above. Do not rewrite, shorten, clean up, or optimize the product title.
- The "content" field must be valid HTML, not Markdown.
- Write at least ${argv['min-words']} words in "content".
- Use useful <h2>, <h3>, <p>, <ul>, and <li> tags.
- Include deal-shopping analysis: why it may be worth checking, what value shoppers might see, who should skip it, what alternatives to compare, and what to verify before buying.
- Include a dedicated product features section with practical feature-focused analysis based only on provided or safely general product information.
- Include bullet points in at least two useful sections, such as product features, who should consider it, who should skip it, alternatives to compare, or what to verify before buying.
- Product feature bullets should explain shopper-relevant benefits or checks, not repeat a raw product/merchant/rank/price/rating recap.
- Include the merchant name, source best-seller page, price, rating, rank, and merchant URL naturally inside the article body exactly as provided when they are listed.
- Do not create a "Quick Deal Snapshot", "Deal Snapshot", "Product Snapshot", summary facts box, or opening bullet-list recap section.
- Do not include the merchant image URL inside "content"; the script inserts the feature image and product card automatically.
- Do not invent exact specs, prices, ratings, discounts, availability, warranties, certifications, or claims.
- Keep seoDescription at most 160 characters.
- Do not include markdown fences.`;

  const text = await callAI({
    system: 'You are a senior deals editor for an ecommerce shopping site. Return strict JSON only and do not invent current product facts.',
    user: prompt,
    maxTokens: Math.max(Number(maxOutputTokensEnv()) || 0, 16000),
  });
  const post = parseJson(text);
  validatePost(post);
  post.title = limitText(product.title, 255);
  post.slug = slugifyValue(post.title);
  post.excerpt = limitText(post.excerpt, 500);
  post.seoTitle = limitText(post.seoTitle, 70);
  post.seoDescription = limitText(post.seoDescription, 160);
  post.seoKeywords = limitText(post.seoKeywords, 255);
  post.content = buildDealSnapshotIntro(product, sanitizeGeneratedHtml(post.content));
  post.readingTimeMinutes = Number(post.readingTimeMinutes) || estimateReadingTime(post.content);

  const words = wordCount(post.content);
  if (words < argv['min-words']) {
    throw new Error(`${activeProviderName()} returned ${words} words; minimum is ${argv['min-words']}. Run again or increase max tokens.`);
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
  if (!res.ok) throw new Error(`Failed to download merchant image ${imageUrl}: ${res.status}`);

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
    sourceUrl: product.url,
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

  console.log(`NXT.Bargains Deals generator`);
  console.log(`AI: ${aiProvider} | Model: ${activeModel()} | merchant: ${argv.merchant || 'all'} | count: ${argv.count} | images: ${argv.images} | dry-run: ${argv['dry-run']} | publish: ${argv.publish}\n`);

  const products = pickRandomProducts(argv.count);
  const categoryId = argv['dry-run'] ? null : await resolveDealsCategoryId();
  const results = [];

  for (const [index, product] of products.entries()) {
    console.log(`[${index + 1}/${products.length}] ${product.marketplace} #${product.rank ?? '?'} · ${product.title}`);
    const post = await generatePost(product);

    if (argv['dry-run']) {
      console.log(JSON.stringify({ product, post }, null, 2));
      results.push({ status: 'dry-run', slug: post.slug });
      continue;
    }

    let coverId = null;
    if (argv.images && product.image) {
      try {
        coverId = await uploadImageToStrapi(product.image, slugifyValue(post.title).slice(0, 60));
      } catch (error) {
        console.log(`  image upload failed (${error.message.slice(0, 140)}) - saving post with external image in content only`);
      }
    }

    const saved = await postToStrapi(post, product, { categoryId, coverId });
    const id = saved?.data?.documentId || saved?.data?.id;
    const adminUrl = `${STRAPI_URL}/admin/content-manager/collection-types/${ADMIN_UID}/${id}`;
    console.log(`  saved ${argv.publish ? 'published' : 'draft'}: ${post.slug}${coverId ? ` · cover=${coverId}` : ''}`);
    console.log(`  review: ${adminUrl}\n`);
    results.push({ status: argv.publish ? 'published' : 'draft', slug: post.slug, id });
  }

  console.log('Done.');
  for (const result of results) {
    console.log(`- ${result.status}: ${result.slug}`);
  }
}

run().catch((error) => fatal(error.message));
