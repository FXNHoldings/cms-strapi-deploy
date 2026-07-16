#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_OPENCLAW_NODE = '/root/.nvm/versions/node/v22.23.1/bin/node';
const DEFAULT_OPENCLAW_BIN = '/opt/openclaw-runtime/openclaw/openclaw.mjs';

const APP_DIR = resolve('/opt/strapi-cms-git/backend/nxt-sourcing');
loadEnv(resolve(APP_DIR, '.env.local'));

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const FRONTEND_URL = (process.env.NXT_BARGAINS_URL || process.env.NEXT_PUBLIC_NXT_BARGAINS_URL || 'https://nxt.bargains').replace(/\/$/, '');
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';
const WRITE = Boolean(args.write);
const OVERWRITE = Boolean(args.overwrite);
const ALL_PRODUCTS = Boolean(args.all);
const LIMIT = ALL_PRODUCTS ? 0 : positiveInt(args.limit, 10);
const CATEGORY = text(args.category || args.categorySlug);
const COLOR_TERMS = [
  'aqua',
  'beige',
  'black',
  'blue',
  'blue titanium',
  'cloud white',
  'cream',
  'deep blue',
  'desert titanium',
  'graphite',
  'gray',
  'green',
  'hazel',
  'jet black',
  'lavender',
  'midnight',
  'mint',
  'moonstone',
  'natural titanium',
  'navy',
  'obsidian',
  'peony',
  'pink',
  'pink gold',
  'porcelain',
  'purple',
  'red',
  'rose',
  'rose gold',
  'sapphire blue',
  'sierra blue',
  'silver',
  'silver shadow',
  'sky blue',
  'soft pink',
  'space black',
  'space gray',
  'starlight',
  'teal',
  'titanium black',
  'titanium gray',
  'titanium grey',
  'titanium jetblack',
  'titanium pink gold',
  'ultramarine',
  'white',
  'yellow',
].sort((a, b) => b.length - a.length);

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is not set in .env.local.');
if (!aiProviderConfig()) {
  fail(
    'No AI provider available. Install OpenClaw at /opt/openclaw-runtime, or set OPENROUTER_API_KEY / OPENAI_API_KEY in .env.local.',
  );
}

const categoryFilter = CATEGORY ? await resolveCategoryFilter(CATEGORY) : null;
if (CATEGORY && !categoryFilter) fail(`No active commerce category found for "${CATEGORY}". Use the category name or slug exactly as it appears in Strapi.`);

const products = await loadProducts();

if (!products.length) {
  console.log('No matching products found.');
  process.exit(0);
}

let processed = 0;
let updated = 0;
let skipped = 0;

for (const product of products) {
  processed += 1;
  const name = text(product.name);
  const documentId = text(product.documentId);

  if (!documentId) {
    console.log(`- skipped ${name || product.id}: missing documentId`);
    skipped += 1;
    continue;
  }

  if (!OVERWRITE && hasTitleRewrite(product)) {
    console.log(`- skipped ${name}: title was already rewritten. Use --overwrite to replace.`);
    skipped += 1;
    continue;
  }

  try {
    const title = await rewriteProductTitle(product);
    if (!title || normalizeTitle(title) === normalizeTitle(name)) {
      console.log(`- skipped ${name}: rewritten title was unchanged.`);
      skipped += 1;
      continue;
    }

    const originalSlug = text(product.slug);
    const slug = uniqueSlug(await availableSlug(slugify(title), documentId));
    const data = {
      name: title,
      slug,
      specs: {
        ...(isRecord(product.specs) ? product.specs : {}),
        titleRewrite: {
          originalTitle: name,
          rewrittenTitle: title,
          originalSlug,
          rewrittenSlug: slug,
          provider: aiProviderName(),
          model: aiModel(),
          rewrittenAt: new Date().toISOString(),
          source: 'rewrite-product-title.mjs',
        },
      },
    };

    if (WRITE) {
      await updateProduct(documentId, data);
      updated += 1;
      console.log(`+ updated ${name} -> ${title}`);
      console.log(`  slug: ${originalSlug || '(none)'} -> ${slug}`);
      console.log(`  frontend: ${frontendProductUrl(slug)}`);
    } else {
      console.log(`\nDRY RUN ONLY - NOT SAVED TO STRAPI OR FRONTEND: ${name} (${documentId})`);
      console.log(`New title:\n${title}\n`);
      console.log(`New slug:\n${slug}\n`);
      console.log(`Frontend URL after save would be:\n${frontendProductUrl(slug)}\n`);
      console.log('Run again with --write to update Strapi and the frontend product URL.');
    }
  } catch (error) {
    skipped += 1;
    console.error(`! failed ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(JSON.stringify({ dryRun: !WRITE, category: categoryFilter?.name || CATEGORY || null, processed, updated, skipped }, null, 2));
if (!WRITE) {
  console.log('No changes were saved. Add --write to update Strapi. If the slug changes, use the new frontend URL printed above.');
}

async function loadProducts() {
  if (args.id || args.documentId) {
    const documentId = String(args.id || args.documentId);
    const product = await getProductByDocumentId(documentId);
    return product ? [product] : [];
  }

  if (args.slug) {
    const product = await getProductBySlug(String(args.slug));
    return product ? [product] : [];
  }

  return listProducts(ALL_PRODUCTS ? 0 : LIMIT, categoryFilter);
}

async function getProductByDocumentId(documentId) {
  const response = await fetch(`${STRAPI_URL}/api/commerce-products/${encodeURIComponent(documentId)}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Strapi product lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data || null;
}

async function getProductBySlug(slug) {
  const params = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
  });
  const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi product slug lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data?.[0] || null;
}

async function availableSlug(baseSlug, documentId) {
  const fallback = baseSlug || `product-${documentId}`;
  for (let index = 0; index < 50; index += 1) {
    const candidate = index === 0 ? fallback : `${fallback}-${index + 1}`;
    const existing = await getProductBySlug(candidate);
    if (!existing || text(existing.documentId) === documentId) return candidate;
  }
  return `${fallback}-${Date.now()}`;
}

function uniqueSlug(value) {
  return value.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 180);
}

function frontendProductUrl(slug) {
  return `${FRONTEND_URL}/products/${encodeURIComponent(slug)}`;
}

async function resolveCategoryFilter(category) {
  const params = new URLSearchParams({
    'filters[$or][0][slug][$eqi]': category,
    'filters[$or][1][name][$eqi]': category,
    'filters[categoryStatus][$eq]': 'active',
    'pagination[pageSize]': '1',
  });
  const response = await fetch(`${STRAPI_URL}/api/commerce-categories?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi category lookup failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  const categoryRow = json.data?.[0];
  return categoryRow ? { name: text(categoryRow.name), slug: text(categoryRow.slug) } : null;
}

async function listProducts(limit, category) {
  const pageSize = 100;
  const all = [];
  let page = 1;

  for (;;) {
    const batch = await listProductsPage(page, pageSize, category);
    if (!batch.length) break;
    all.push(...batch);
    if (limit > 0 && all.length >= limit) return all.slice(0, limit);
    if (batch.length < pageSize) break;
    page += 1;
  }

  return all;
}

async function listProductsPage(page, pageSize, category) {
  const params = new URLSearchParams({
    'pagination[page]': String(page),
    'pagination[pageSize]': String(pageSize),
    'filters[productStatus][$eq]': 'active',
    'sort[0]': 'updatedAt:desc',
  });
  if (category?.slug) {
    params.set('filters[categories][slug][$eqi]', category.slug);
  }
  const response = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi product list failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return Array.isArray(json.data) ? json.data : [];
}

async function updateProduct(documentId, data) {
  const response = await fetch(`${STRAPI_URL}/api/commerce-products/${encodeURIComponent(documentId)}`, {
    method: 'PUT',
    headers: strapiHeaders(),
    body: JSON.stringify({ data: prune(data) }),
  });
  if (!response.ok) throw new Error(`Strapi product update failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function rewriteProductTitle(product) {
  const provider = aiProviderConfig();
  const prompt = titleRewritePrompt(product);
  const content =
    provider.type === 'openclaw'
      ? await invokeOpenClawInfer(prompt, provider.model)
      : await invokeChatCompletion(provider, prompt);
  const parsed = parseJsonContent(String(content || ''));
  const title = finalizeTitle(cleanTitle(parsed.title), product);
  if (!title) throw new Error('AI response did not include title.');
  return title;
}

function titleRewritePrompt(product) {
  return [
    'You rewrite ecommerce product titles for NXT.Bargains. Return only valid JSON. Make titles clearer, more professional, and SEO-friendly for an ecommerce store while preserving the original meaning and product type.',
    '',
    `Current title: ${text(product.name)}`,
    text(product.brand) ? `Brand: ${text(product.brand)}` : '',
    text(product.category) ? `Category: ${text(product.category)}` : '',
    text(product.shortDescription) ? `Short description: ${cleanText(product.shortDescription, 700)}` : '',
    text(product.description) ? `Description: ${cleanText(product.description, 1200)}` : '',
    specsForPrompt(product.specs) ? `Specifications:\n${specsForPrompt(product.specs)}` : '',
    '',
    'Rules:',
    '- Keep the original meaning and product type.',
    '- Do not add features, materials, brands, sizes, claims, warranties, merchant names, or compatibility details that are not provided.',
    '- The title must start with the product brand and model, for example "Google Pixel 8".',
    '- Do not include color names or color phrases in the title.',
    '- Put the most important ecommerce keywords first, such as brand, model, product type, capacity, and size when provided.',
    '- Make it readable for customers, not keyword-stuffed.',
    '- Remove unnecessary words, symbols, duplicate keywords, repeated specs, condition clutter, and awkward wording.',
    '- Keep the title under 80 characters if possible; only exceed 80 when needed to preserve essential model/capacity/product identity.',
    '- Use title case.',
    '',
    'Write JSON with exactly this key:',
    '{"title":"Rewritten product title"}',
  ]
    .filter(Boolean)
    .join('\n');
}

async function invokeChatCompletion(provider, prompt) {
  const messages = [
    {
      role: 'system',
      content:
        'You rewrite ecommerce product titles for NXT.Bargains. Return only valid JSON. Make titles clearer, more professional, and SEO-friendly for an ecommerce store while preserving the original meaning and product type.',
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: provider.headers,
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: Number(process.env.PRODUCT_TITLE_REWRITE_TEMPERATURE || '0.25'),
      max_tokens: Number(process.env.PRODUCT_TITLE_REWRITE_MAX_TOKENS || '256'),
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) throw new Error(`AI title rewrite failed: HTTP ${response.status} ${await response.text()}`);

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content;
}

function aiProviderPreference() {
  const explicit = text(process.env.PRODUCT_TITLE_REWRITE_PROVIDER || process.env.PRODUCT_DESCRIPTION_REWRITE_PROVIDER).toLowerCase();
  if (explicit) return explicit;
  return 'openclaw';
}

function openClawPaths() {
  const nodePath = process.env.OPENCLAW_NODE || DEFAULT_OPENCLAW_NODE;
  const binPath = process.env.OPENCLAW_BIN || DEFAULT_OPENCLAW_BIN;
  return { nodePath, binPath };
}

function openClawAvailable() {
  const { nodePath, binPath } = openClawPaths();
  return existsSync(nodePath) && existsSync(binPath);
}

function aiProviderConfig() {
  const preference = aiProviderPreference();

  if (preference === 'openclaw' || (preference !== 'openrouter' && preference !== 'openai')) {
    if (openClawAvailable()) {
      return {
        type: 'openclaw',
        model: aiModel(),
        ...openClawPaths(),
      };
    }
    if (preference === 'openclaw') return null;
  }

  if (preference !== 'openai' && process.env.OPENROUTER_API_KEY) {
    return {
      type: 'openrouter',
      url: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
      model: aiModel(),
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://search.fxnstudio.com',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'NXT Commerce Sourcing',
      },
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      type: 'openai',
      url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
      model: aiModel(),
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
  }

  if (openClawAvailable()) {
    return {
      type: 'openclaw',
      model: aiModel(),
      ...openClawPaths(),
    };
  }

  return null;
}

function aiProviderName() {
  const provider = aiProviderConfig();
  return provider?.type || 'unknown';
}

function aiModel() {
  const preference = aiProviderPreference();
  const usingOpenClaw =
    preference === 'openclaw' ||
    (preference !== 'openrouter' && preference !== 'openai' && openClawAvailable());

  if (usingOpenClaw) {
    return process.env.OPENCLAW_MODEL || process.env.PRODUCT_TITLE_REWRITE_MODEL || 'openai/gpt-5.5';
  }

  if (process.env.PRODUCT_TITLE_REWRITE_MODEL) return process.env.PRODUCT_TITLE_REWRITE_MODEL;
  if (process.env.PRODUCT_DESCRIPTION_REWRITE_MODEL) return process.env.PRODUCT_DESCRIPTION_REWRITE_MODEL;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.6';
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

async function invokeOpenClawInfer(prompt, model) {
  const provider = aiProviderConfig();
  if (!provider || provider.type !== 'openclaw') {
    throw new Error('OpenClaw provider is not configured.');
  }

  const args = [provider.binPath, 'infer', 'model', 'run', '--local', '--json', '--prompt', prompt];
  if (model) args.push('--model', model);

  const { stdout, stderr, code } = await runProcess(provider.nodePath, args);
  if (code !== 0) {
    throw new Error(`OpenClaw infer failed: ${extractProcessError(stderr, stdout)}`);
  }

  const payload = parseOpenClawJson(stdout);
  if (!payload.ok) {
    throw new Error(`OpenClaw infer failed: ${payload.error || JSON.stringify(payload)}`);
  }

  const textOutput = payload.outputs?.[0]?.text;
  if (!text(textOutput)) {
    throw new Error('OpenClaw returned no text output.');
  }

  return textOutput;
}

function parseOpenClawJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) throw new Error('OpenClaw returned empty stdout.');

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`OpenClaw returned non-JSON output: ${trimmed.slice(0, 500)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function extractProcessError(stderr, stdout) {
  const combined = [stderr, stdout].filter(Boolean).join('\n').trim();
  return combined ? combined.slice(0, 1200) : 'unknown process error';
}

function runProcess(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function specsForPrompt(specs) {
  if (!isRecord(specs)) return '';
  const rows = [];
  flattenSpecs(specs, rows);
  return rows.slice(0, 60).join('\n');
}

function flattenSpecs(value, rows, prefix = '') {
  if (rows.length >= 80 || value == null) return;
  if (Array.isArray(value)) {
    const items = value.map((entry) => String(entry).trim()).filter(Boolean);
    if (items.length && prefix) rows.push(`${prefix}: ${items.slice(0, 20).join(', ')}`);
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, nested]) => {
      if (['descriptionRewrite', 'titleRewrite', 'imageBackgroundProvider', 'imageBackgroundStorage'].includes(key)) return;
      flattenSpecs(nested, rows, prefix ? `${prefix} / ${key}` : key);
    });
    return;
  }
  const textValue = String(value).replace(/\s+/g, ' ').trim();
  if (textValue && prefix) rows.push(`${prefix}: ${textValue}`);
}

function parseJsonContent(content) {
  const cleaned = content
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function strapiHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
  };
}

function prune(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== ''));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--write') parsed.write = true;
    else if (arg === '--overwrite') parsed.overwrite = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) parsed[key] = true;
      else {
        parsed[key] = next;
        i += 1;
      }
    }
  }
  return parsed;
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) return;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  });
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function cleanTitle(value) {
  const cleaned = cleanText(value, 180);
  if (!cleaned) return undefined;
  return cleaned
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .slice(0, 100)
    .trim();
}

function finalizeTitle(value, product) {
  const cleaned = cleanTitle(value);
  if (!cleaned) return undefined;

  const withoutColors = removeColorTerms(cleaned);
  const prefix = brandModelPrefix(product);
  const withPrefix = prefix ? ensureTitlePrefix(withoutColors, prefix) : withoutColors;

  return cleanTitle(withPrefix);
}

function ensureTitlePrefix(title, prefix) {
  if (!title) return prefix;
  const normalizedTitle = normalizeTitle(title);
  const normalizedPrefix = normalizeTitle(prefix);
  if (!normalizedPrefix || normalizedTitle.startsWith(normalizedPrefix)) return title;

  const titleWords = title.split(/\s+/);
  const prefixWords = prefix.split(/\s+/);
  let overlap = 0;
  const maxOverlap = Math.min(prefixWords.length, titleWords.length);

  for (let size = maxOverlap; size > 0; size -= 1) {
    const titleStart = normalizeTitle(titleWords.slice(0, size).join(' '));
    const prefixEnd = normalizeTitle(prefixWords.slice(-size).join(' '));
    if (titleStart && titleStart === prefixEnd) {
      overlap = size;
      break;
    }
  }

  const remainder = titleWords.slice(overlap).join(' ');
  return cleanTitle(`${prefix} ${remainder}`) || prefix;
}

function brandModelPrefix(product) {
  const brand = text(product.brandRef?.name) || text(product.brand) || inferBrandFromTitle(product.name);
  const model = inferModelFromProduct(product, brand);
  return cleanTitle([brand, model].filter(Boolean).join(' '));
}

function inferModelFromProduct(product, brand) {
  const specs = isRecord(product.specs) ? product.specs : {};
  const candidates = [
    specs.model,
    specs.Model,
    isRecord(specs.technicalSpecs) ? specs.technicalSpecs.Model : undefined,
    isRecord(specs.gsmarena) ? specs.gsmarena.cleanModel : undefined,
    isRecord(specs.gsmarena) ? specs.gsmarena.sourceTitle : undefined,
    product.name,
  ];

  for (const candidate of candidates) {
    const model = modelFromText(text(candidate), brand);
    if (model) return model;
  }

  return '';
}

function modelFromText(value, brand) {
  let source = removeColorTerms(value);
  if (!source) return '';
  if (brand) source = source.replace(new RegExp(`^${escapeRegExp(brand)}\\b`, 'i'), '').trim();

  const patterns = [
    /\b(?:Pixel|Galaxy|iPhone|MacBook|Surface|ThinkPad|IdeaPad|Legion|Yoga|Zenbook|Vivobook|ROG|TUF|Swift|Aspire|Predator|Nitro|XPS|Inspiron|Latitude|Alienware|Spectre|Envy|OmniBook|EliteBook|Dragonfly|gram|Blade|Prestige|Summit|Stealth|Vector|Raider|Titan|Framework)(?:\s+[A-Za-z0-9+.-]+){0,5}/i,
    /\b[A-Z][A-Za-z0-9]+(?:\s+[A-Za-z0-9+.-]+){0,4}/,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern)?.[0];
    if (match) return cleanTitle(stripTitleNoise(match)) || '';
  }

  return '';
}

function inferBrandFromTitle(value) {
  const firstWords = removeColorTerms(text(value)).split(/\s+/).filter(Boolean).slice(0, 2);
  const twoWordBrands = ['Google Pixel', 'Apple iPhone', 'Samsung Galaxy', 'Microsoft Surface', 'Lenovo ThinkPad', 'Lenovo Yoga', 'Dell XPS', 'HP Spectre', 'ASUS ROG', 'Acer Swift'];
  const firstTwo = firstWords.join(' ');
  const matchedTwoWordBrand = twoWordBrands.find((brand) => normalizeTitle(firstTwo).startsWith(normalizeTitle(brand)));
  if (matchedTwoWordBrand) return matchedTwoWordBrand.split(' ')[0];
  return firstWords[0] || '';
}

function removeColorTerms(value) {
  let title = text(value);
  for (const color of COLOR_TERMS) {
    title = title.replace(new RegExp(`\\b${escapeRegExp(color)}\\b`, 'gi'), ' ');
  }
  return stripTitleNoise(title);
}

function stripTitleNoise(value) {
  return text(value)
    .replace(/\s*[-–—,;/]\s*(?:open box|all colors?|network unlocked|factory unlocked|unlocked)\b/gi, ' ')
    .replace(/\b(?:open box|all colors?)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/^[,.;:\-–—\s]+|[,.;:\-–—\s]+$/g, '')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(value) {
  return text(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 180);
}

function normalizeTitle(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasTitleRewrite(product) {
  const specs = isRecord(product.specs) ? product.specs : {};
  return isRecord(specs.titleRewrite) || Boolean(specs.titleRewriteAt || specs.titleRewrittenAt);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`
Rewrite Strapi commerce product titles and slugs.

Usage:
  node scripts/rewrite-product-title.mjs --slug product-slug
  node scripts/rewrite-product-title.mjs --id product-document-id
  node scripts/rewrite-product-title.mjs --limit 5
  node scripts/rewrite-product-title.mjs --all --write

Options:
  --slug <slug>       Rewrite one product title and slug by slug.
  --id <documentId>   Rewrite one product title and slug by Strapi documentId.
  --category <name>   Process recent active products in this commerce category name or slug.
  --all               Process all active products (paginated). Skips already-rewritten unless --overwrite.
  --limit <number>    Process recent active products when no slug/id is provided. Default: 10.
  --overwrite         Rewrite even when specs.titleRewrite already marks the title as rewritten.
  --write             Save title and slug changes to Strapi. Without this, the script only previews terminal output.
  --help              Show this help.

Notes:
  The frontend product URL uses the product slug. When the slug changes, open
  the new /products/<slug> URL printed after a successful --write run.

Environment:
  Reads ${APP_DIR}/.env.local.
  Default AI provider: OpenClaw local inference (${DEFAULT_OPENCLAW_BIN}).
  Override provider with PRODUCT_TITLE_REWRITE_PROVIDER=openclaw|openrouter|openai.
  Requires STRAPI_API_TOKEN. When not using OpenClaw, set OPENROUTER_API_KEY or OPENAI_API_KEY.
  Optional model override: PRODUCT_TITLE_REWRITE_MODEL or OPENCLAW_MODEL.
`);
}
