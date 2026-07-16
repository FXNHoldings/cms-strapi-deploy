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
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';
const WRITE = Boolean(args.write);
const OVERWRITE = Boolean(args.overwrite);
const ALL_PRODUCTS = Boolean(args.all);
const LIMIT = ALL_PRODUCTS ? 0 : positiveInt(args.limit, 10);
const AMAZON_DETAILS_ENABLED = args.amazon !== false && args['no-amazon'] !== true;

if (!STRAPI_API_TOKEN) fail('STRAPI_API_TOKEN is not set in .env.local.');
if (!aiProviderConfig()) {
  fail(
    'No AI provider available. Install OpenClaw at /opt/openclaw-runtime, or set OPENROUTER_API_KEY / OPENAI_API_KEY in .env.local.',
  );
}

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

  if (!OVERWRITE && hasDescriptionRewrite(product)) {
    console.log(`- skipped ${name}: description was already rewritten. Use --overwrite to replace.`);
    skipped += 1;
    continue;
  }

  const amazonDetail = AMAZON_DETAILS_ENABLED ? await amazonDetailForProduct(product) : null;
  const source = [productSourceText(product), amazonSourceText(amazonDetail)].filter(Boolean).join('\n\n');
  const specs = [specsForPrompt(product.specs), amazonDetail ? `Amazon product details:\n${specsForPrompt(amazonDetail)}` : '']
    .filter(Boolean)
    .join('\n\n');

  if (!source && !specs) {
    console.log(`- skipped ${name}: no description/specs source data found.`);
    skipped += 1;
    continue;
  }

  try {
    const rewritten = await rewriteProductDescription(product, source, specs);
    const data = {
      name: rewritten.title,
      shortDescription: rewritten.shortDescription,
      description: rewritten.description,
      specs: {
        ...(isRecord(product.specs) ? product.specs : {}),
        ...(amazonDetail
          ? {
              amazonProductDetails: sanitizeAmazonDetail(amazonDetail),
              amazonProductDetailsImportedAt: new Date().toISOString(),
              amazonProductDetailsSource: 'real-time-amazon-data',
            }
          : {}),
        Features: rewritten.features,
        descriptionRewrite: {
          provider: aiProviderName(),
          model: aiModel(),
          rewrittenAt: new Date().toISOString(),
          source: 'rewrite-product-description.mjs',
          fields: ['name', 'shortDescription', 'description', 'specs.Features'],
          amazonDetailsFetched: Boolean(amazonDetail),
        },
      },
    };

    if (WRITE) {
      await updateProduct(documentId, data);
      updated += 1;
      console.log(`+ updated ${name} (${documentId})`);
    } else {
      console.log(`\nDRY RUN: ${name} (${documentId})`);
      console.log(`Title:\n${data.name}\n`);
      console.log(`Short description:\n${data.shortDescription}\n`);
      console.log(`Description:\n${data.description}\n`);
      console.log(`Features:\n${data.specs.Features.map((feature) => `- ${feature}`).join('\n')}\n`);
      if (amazonDetail) console.log('Amazon details: fetched and will be saved to specs.amazonProductDetails with --write.\n');
    }
  } catch (error) {
    skipped += 1;
    console.error(`! failed ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(JSON.stringify({ dryRun: !WRITE, processed, updated, skipped }, null, 2));

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

  return listProducts(LIMIT, text(args.category));
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

async function listProducts(limit, categoryFilter = '') {
  const pageSize = 100;
  const all = [];
  let page = 1;

  for (;;) {
    const batch = await listProductsPage(page, pageSize, categoryFilter);
    if (!batch.length) break;
    all.push(...batch);
    if (limit > 0 && all.length >= limit) return all.slice(0, limit);
    if (batch.length < pageSize) break;
    page += 1;
  }

  return all;
}

async function listProductsPage(page, pageSize, categoryFilter = '') {
  const params = new URLSearchParams({
    'pagination[page]': String(page),
    'pagination[pageSize]': String(pageSize),
    'filters[productStatus][$eq]': 'active',
    'sort[0]': 'updatedAt:desc',
  });
  const category = text(categoryFilter);
  if (category) {
    const slug = category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    params.set('filters[$or][0][categories][slug][$eq]', slug);
    params.set('filters[$or][1][category][$eqi]', category);
    params.set('populate[categories][fields][0]', 'slug');
    params.set('populate[categories][fields][1]', 'name');
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

async function amazonDetailForProduct(product) {
  const asin = amazonAsinForProduct(product);
  const key = getAmazonDetailApiKey();
  if (!asin || !key) return null;

  try {
    const detail = await fetchAmazonProductDetail(asin);
    console.log(`  fetched Amazon details for ASIN ${asin}`);
    return detail;
  } catch (error) {
    console.warn(`  Amazon detail unavailable for ${asin}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function fetchAmazonProductDetail(asin) {
  const key = getAmazonDetailApiKey();
  const host = process.env.RAPIDAPI_AMAZON_HOST || 'real-time-amazon-data.p.rapidapi.com';
  const path = normalizeApiPath(process.env.RAPIDAPI_AMAZON_DETAILS_PATH || '/product-details');
  const params = new URLSearchParams({
    asin,
    country: process.env.RAPIDAPI_AMAZON_COUNTRY || 'US',
  });

  const response = await fetch(`https://${host}${path}?${params.toString()}`, {
    headers: {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': host,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(positiveInt(process.env.RAPIDAPI_AMAZON_DETAILS_TIMEOUT_MS, 15_000)),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

  const payload = await response.json();
  const detail = amazonDetailFromPayload(payload);
  if (!detail) throw new Error('Amazon product details payload did not include a product record.');
  return detail;
}

function amazonDetailFromPayload(payload) {
  if (!isRecord(payload)) return null;
  for (const key of ['data', 'product', 'product_details', 'result', 'item', 'results']) {
    const value = payload[key];
    if (Array.isArray(value)) {
      const match = value.find((entry) => isAmazonProductRecord(entry));
      if (match) return match;
    }
    if (isRecord(value)) return value;
  }
  const nested = findAmazonProductRecord(payload);
  if (nested) return nested;
  return payload.asin || payload.product_title || payload.product_description ? payload : null;
}

function findAmazonProductRecord(value, depth = 0) {
  if (depth > 4) return null;
  if (isAmazonProductRecord(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAmazonProductRecord(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const item of Object.values(value)) {
    const found = findAmazonProductRecord(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function isAmazonProductRecord(value) {
  if (!isRecord(value)) return false;
  return Boolean(
    value.asin ||
      value.product_title ||
      value.product_description ||
      value.about_product ||
      value.product_information ||
      value.product_details ||
      value.title,
  );
}

function amazonAsinForProduct(product) {
  const specs = isRecord(product.specs) ? product.specs : {};
  const technicalSpecs = isRecord(specs.technicalSpecs) ? specs.technicalSpecs : {};
  for (const value of [
    product.asin,
    product.merchantSku,
    product.sku?.replace(/^amazon-/i, ''),
    specs.ASIN,
    specs.asin,
    specs.amazonAsin,
    technicalSpecs.ASIN,
    technicalSpecs.asin,
    asinFromUrl(product.productUrl),
    asinFromUrl(product.affiliateUrl),
  ]) {
    const asin = validAsin(typeof value === 'string' ? value : undefined);
    if (asin) return asin;
  }
  return undefined;
}

function validAsin(value) {
  const candidate = value?.trim().toUpperCase();
  return candidate && /^[A-Z0-9]{10}$/.test(candidate) ? candidate : undefined;
}

function asinFromUrl(value) {
  if (!value) return undefined;
  return value.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase();
}

function getAmazonDetailApiKey() {
  return process.env.RAPIDAPI_AMAZON_KEY || process.env.RAPIDAPI_PRODUCT_SEARCH_KEY || process.env.RAPIDAPI_KEY || '';
}

function normalizeApiPath(value) {
  const path = String(value || '').trim() || '/product-details';
  return path.startsWith('/') ? path : `/${path}`;
}

function rewritePrompt(product, source, specs) {
  return [
    'You rewrite ecommerce product listings for NXT.Bargains. Return only valid JSON. Do not add markdown outside JSON, citations, unsupported claims, warranties, or facts not supported by the provided source details.',
    '',
    `Product: ${text(product.name)}`,
    text(product.brand) ? `Brand: ${text(product.brand)}` : '',
    text(product.category) ? `Category: ${text(product.category)}` : '',
    '',
    'Existing product title:',
    text(product.name) || 'Not provided.',
    '',
    'Existing product description:',
    source || 'Not provided.',
    '',
    'Product specifications:',
    specs || 'Not provided.',
    '',
    'Requirements:',
    '- Rewrite the product title so it is clean, specific, shopper-friendly, and keeps the same product identity.',
    '- Product description must contain at least 4 paragraphs.',
    '- One paragraph in the description must be a bullet-point paragraph using hyphen bullets.',
    '- Generate a Features section as 4 to 8 concise bullet points.',
    '- Use only the supplied description and specifications.',
    '',
    'Write JSON with exactly these keys:',
    '{"title":"Rewritten product title, 140 characters or less.","shortDescription":"One polished summary, 220 characters or less.","description":"A clear product description in at least 4 paragraphs, 220 to 520 words, with one paragraph formatted as hyphen bullet points.","features":["Feature bullet 1","Feature bullet 2","Feature bullet 3","Feature bullet 4"]}',
  ]
    .filter(Boolean)
    .join('\n');
}

async function rewriteProductDescription(product, source, specs) {
  const provider = aiProviderConfig();
  const prompt = rewritePrompt(product, source, specs);
  const content =
    provider.type === 'openclaw'
      ? await invokeOpenClawInfer(prompt, provider.model)
      : await invokeChatCompletion(provider, prompt);
  const parsed = parseJsonContent(String(content || ''));
  const title = cleanText(parsed.title, 140);
  const shortDescription = cleanText(parsed.shortDescription, 360);
  const features = cleanFeatures(parsed.features);
  const description = normalizeDescriptionMarkdown(parsed.description, features);
  if (!title || !shortDescription || !description || !features.length) {
    throw new Error('AI response did not include title, shortDescription, description, and features.');
  }
  return { title, shortDescription, description, features };
}

function aiProviderPreference() {
  const explicit = text(process.env.PRODUCT_DESCRIPTION_REWRITE_PROVIDER).toLowerCase();
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
    return process.env.OPENCLAW_MODEL || 'openai/gpt-5.5';
  }

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

async function invokeChatCompletion(provider, prompt) {
  const messages = [
    {
      role: 'system',
      content:
        'You rewrite ecommerce product listings for NXT.Bargains. Return only valid JSON. Do not add markdown outside JSON, citations, unsupported claims, warranties, or facts not supported by the provided source details.',
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
      temperature: Number(process.env.PRODUCT_DESCRIPTION_REWRITE_TEMPERATURE || '0.35'),
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) throw new Error(`AI rewrite failed: HTTP ${response.status} ${await response.text()}`);

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content;
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

function productSourceText(product) {
  return [product.shortDescription, product.description]
    .map((value) => cleanText(value, 5000))
    .filter(Boolean)
    .join('\n\n');
}

function amazonSourceText(detail) {
  if (!isRecord(detail)) return '';
  const sections = [];
  for (const key of [
    'product_title',
    'title',
    'product_byline',
    'brand',
    'product_description',
    'description',
    'about_product',
    'product_information',
    'product_details',
    'category_path',
    'customers_say',
    'delivery',
    'primary_delivery_time',
    'sales_volume',
    'product_variations',
  ]) {
    const value = detail[key];
    const rendered = renderPromptValue(value);
    if (rendered) sections.push(`${key}:\n${rendered}`);
  }
  const flattened = specsForPrompt(detail);
  if (flattened) sections.push(`all_amazon_fields:\n${flattened}`);
  return sections.length ? `Amazon source data:\n${sections.join('\n\n')}` : '';
}

function specsForPrompt(specs) {
  if (!isRecord(specs)) return '';
  const rows = [];
  flattenSpecs(specs, rows);
  return rows.slice(0, 100).join('\n');
}

function productFeatures(specs) {
  if (!isRecord(specs)) return [];
  const candidates = [
    specs.Features,
    specs.features,
    specs.featureBullets,
    specs['Feature Bullets'],
    isRecord(specs.technicalSpecs) ? specs.technicalSpecs.Features : undefined,
  ];
  for (const candidate of candidates) {
    const features = cleanFeatures(candidate);
    if (features.length) return features;
  }
  return [];
}

function hasDescriptionRewrite(product) {
  const specs = isRecord(product.specs) ? product.specs : {};
  return isRecord(specs.descriptionRewrite) || Boolean(specs.descriptionRewriteAt || specs.descriptionRewrittenAt);
}

function flattenSpecs(value, rows, prefix = '') {
  if (rows.length >= 120 || value == null) return;
  if (Array.isArray(value)) {
    const items = value.map((entry) => String(entry).trim()).filter(Boolean);
    if (items.length && prefix) rows.push(`${prefix}: ${items.slice(0, 30).join(', ')}`);
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, nested]) => {
      if (['descriptionRewrite', 'imageBackgroundProvider', 'imageBackgroundStorage'].includes(key)) return;
      flattenSpecs(nested, rows, prefix ? `${prefix} / ${key}` : key);
    });
    return;
  }
  const textValue = String(value).replace(/\s+/g, ' ').trim();
  if (textValue && prefix) rows.push(`${prefix}: ${textValue}`);
}

function renderPromptValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return cleanText(value, 4000) || '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 40)
      .map((entry) => renderPromptValue(entry))
      .filter(Boolean)
      .join('\n');
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .slice(0, 80)
      .map(([key, nested]) => {
        const rendered = renderPromptValue(nested);
        return rendered ? `${key}: ${rendered}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function sanitizeAmazonDetail(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return cleanText(value, 2000) || '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((entry) => sanitizeAmazonDetail(entry, depth + 1));
  if (!isRecord(value) || depth >= 6) return undefined;

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 180)
      .map(([key, nested]) => [key, sanitizeAmazonDetail(nested, depth + 1)])
      .filter(([, nested]) => nested !== undefined && nested !== ''),
  );
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

function stringArg(value) {
  return text(value);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--write') parsed.write = true;
    else if (arg === '--overwrite') parsed.overwrite = true;
    else if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        parsed[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const key = body;
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

function cleanFeatures(value) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n|[;•]/)
      : [];
  return rawItems
    .map((item) => cleanText(String(item).replace(/^[-*]\s*/, ''), 220))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeDescriptionMarkdown(value, features) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return undefined;

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean);

  if (!paragraphs.some((paragraph) => /^[-*]\s+/m.test(paragraph)) && features.length) {
    paragraphs.splice(Math.min(2, paragraphs.length), 0, features.slice(0, 5).map((feature) => `- ${feature}`).join('\n'));
  }

  while (paragraphs.length < 4) {
    paragraphs.push('Review the live merchant listing for the latest pricing, availability, included accessories, compatibility details, and shipping information before you buy.');
  }

  return paragraphs.join('\n\n').slice(0, 7000);
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
Rewrite/generate Strapi commerce product descriptions.
Also rewrites the product title and generates a specs.Features section.

Usage:
  node scripts/rewrite-product-description.mjs --slug product-slug
  node scripts/rewrite-product-description.mjs --id product-document-id
  node scripts/rewrite-product-description.mjs --limit 5
  node scripts/rewrite-product-description.mjs --all --write
  node scripts/rewrite-product-description.mjs --category=smart-cameras --all --write

Options:
  --slug <slug>       Rewrite one product by slug.
  --id <documentId>   Rewrite one product by Strapi documentId.
  --category <value>  Filter by commerce category slug or name (e.g. smart-cameras or "Smart Cameras").
  --limit <number>    Process recent active products when no slug/id is provided. Default: 10.
  --all               Process all active products (paginated). Skips already-rewritten unless --overwrite.
  --overwrite         Rewrite even when specs.descriptionRewrite already marks the description as rewritten.
  --no-amazon         Do not fetch Real-Time Amazon Data details, even when an ASIN is available.
  --write             Save changes to Strapi. Without this, the script is dry-run only.
  --help              Show this help.

Environment:
  Reads ${APP_DIR}/.env.local.
  Default AI provider: OpenClaw local inference (${DEFAULT_OPENCLAW_BIN}).
  Optional overrides:
    PRODUCT_DESCRIPTION_REWRITE_PROVIDER=openclaw|openrouter|openai
    OPENCLAW_NODE, OPENCLAW_BIN, OPENCLAW_MODEL
    OPENROUTER_API_KEY or OPENAI_API_KEY when not using OpenClaw
  Requires STRAPI_API_TOKEN.
  Amazon enrichment uses RAPIDAPI_AMAZON_KEY, RAPIDAPI_PRODUCT_SEARCH_KEY, or RAPIDAPI_KEY.
`);
}
