#!/usr/bin/env node
// FXN — Generate / rewrite `shortDescription` + `description` for
// commerce-products using Claude. Mirrors the enrich-*-content.js scripts.
//
// - shortDescription: 1–2 sentence plain-text summary (~20–40 words).
// - description: markdown the storefront renders (### headings + "- " bullets +
//   paragraphs separated by blank lines).
//
// By default it ONLY fills products missing copy and never overwrites good
// text. Use --overwrite to rewrite everything. Always preview with --dry-run.
//
// Usage:
//   node enrich-product-descriptions.js --dry-run                       # preview, all missing
//   node enrich-product-descriptions.js --slugs google-pixel-10-...     # specific products
//   node enrich-product-descriptions.js --category facial-serums        # one category
//   node enrich-product-descriptions.js --all --limit 25                # all, capped
//   node enrich-product-descriptions.js --slugs foo --overwrite         # rewrite existing

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('slugs', { type: 'string', describe: 'Comma-separated commerce-product slugs' })
  .option('category', { type: 'string', describe: 'Only products in this category slug' })
  .option('all', { type: 'boolean', default: false, describe: 'Process all products' })
  .option('limit', { type: 'number', default: 50, describe: 'Max products to process' })
  .option('overwrite', { type: 'boolean', default: false, describe: 'Rewrite existing copy too' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Preview only, no writes' })
  .option('model', { type: 'string', describe: 'Override CLAUDE_MODEL' })
  .help()
  .parseSync();

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  CLAUDE_MAX_TOKENS = '2000',
  STRAPI_URL,
  STRAPI_API_TOKEN,
} = process.env;

const MODEL = argv.model || CLAUDE_MODEL;

function fatal(m) { console.error('✖', m); process.exit(1); }
if (!ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set in .env');
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!argv['dry-run'] && !STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
if (!argv.slugs && !argv.category && !argv.all) {
  fatal('Pick a scope: --slugs <a,b>, --category <slug>, or --all');
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Strapi ${res.status} on ${pathname}: ${(await res.text()).slice(0, 240)}`);
  return res.json();
}

/* ---------- fetch products ---------- */

async function fetchProducts() {
  const base = '/api/commerce-products';
  const common = 'populate[categories][fields][0]=name&populate[brandRef][fields][0]=name';
  const out = [];

  if (argv.slugs) {
    const slugs = argv.slugs.split(',').map((s) => s.trim()).filter(Boolean);
    for (const slug of slugs) {
      const q = `?filters[slug][$eq]=${encodeURIComponent(slug)}&${common}&pagination[pageSize]=1`;
      const r = await strapi(`${base}${q}`);
      if (r?.data?.[0]) out.push(r.data[0]);
      else console.warn(`  (no product found for slug "${slug}")`);
    }
    return out;
  }

  let page = 1;
  const pageSize = 50;
  while (out.length < argv.limit) {
    const filter = argv.category
      ? `filters[categories][slug][$eq]=${encodeURIComponent(argv.category)}&`
      : '';
    const q = `?${filter}${common}&pagination[page]=${page}&pagination[pageSize]=${pageSize}&sort[0]=updatedAt:desc`;
    const r = await strapi(`${base}${q}`);
    const rows = r?.data ?? [];
    out.push(...rows);
    const pageCount = r?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount || rows.length === 0) break;
    page += 1;
  }
  return out.slice(0, argv.limit);
}

const isWeak = (s) => !s || String(s).trim().length < 40;

/* ---------- Claude ---------- */

const SYSTEM = `You are a senior e-commerce copywriter. You write accurate, helpful product copy — never invented specs, never hype. Use only the facts provided; if a detail is unknown, omit it.

Return STRICT JSON only (no markdown fences) with exactly these keys:
{
  "shortDescription": string,  // 1–2 sentences, ~20–40 words, plain text (no markdown). A crisp summary of what the product is and its main benefit.
  "description": string        // 180–320 words of MARKDOWN. REQUIREMENTS:
                               //   - At least THREE body paragraphs of prose.
                               //   - Exactly ONE of those sections must be a bullet-point list (3–6 "- " items).
                               // Recommended shape:
                               //   (a 1–2 sentence intro paragraph, no heading)
                               //   ### Overview        — a full paragraph (2–4 sentences)
                               //   ### Key Features    — 3–6 "- " bullet points
                               //   ### Who It's For     — a full paragraph (2–4 sentences)
                               // Separate every block with a blank line. Use only "###" headings and "- " bullets.
}`;

function userPrompt(p) {
  const a = p.attributes ?? p;
  const cats = (a.categories?.data ?? a.categories ?? [])
    .map((c) => (c.attributes ?? c).name).filter(Boolean).join(', ');
  const brand = (a.brandRef?.data ?? a.brandRef)?.attributes?.name
    || (a.brandRef ?? {}).name || a.brand || '';
  const specs = a.specs && typeof a.specs === 'object' ? a.specs : {};
  const tech = specs.technicalSpecs && typeof specs.technicalSpecs === 'object' ? specs.technicalSpecs : {};
  const features = Array.isArray(specs.keyFeatures) ? specs.keyFeatures : [];
  const lines = [
    `Product name: ${a.name}`,
    brand ? `Brand: ${brand}` : '',
    cats ? `Category: ${cats}` : '',
    features.length ? `Key features: ${features.join('; ')}` : '',
    Object.keys(tech).length ? `Technical specs: ${Object.entries(tech).map(([k, v]) => `${k}: ${v}`).join('; ')}` : '',
    a.shortDescription ? `Existing short description (improve, keep facts): ${a.shortDescription}` : '',
  ].filter(Boolean);
  return `Write product copy for:\n\n${lines.join('\n')}`;
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function callClaude(content) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: Number(CLAUDE_MAX_TOKENS),
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return parseJson(text);
}

// Enforce: at least 3 prose/content blocks AND one bullet-point list.
function meetsRequirements(desc) {
  if (!desc) return false;
  const hasBullets = /(^|\n)\s*-\s+\S/.test(desc);
  const contentBlocks = desc
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => {
      const lines = b.split('\n').filter(Boolean);
      return !(lines.length === 1 && lines[0].startsWith('#')); // drop heading-only blocks
    }).length;
  return hasBullets && contentBlocks >= 3;
}

async function generate(p) {
  let result = await callClaude(userPrompt(p));
  if (!meetsRequirements(result.description)) {
    // One retry with an explicit reminder.
    result = await callClaude(
      userPrompt(p) +
        '\n\nIMPORTANT: the "description" MUST contain at least 3 paragraphs AND exactly one bullet-point list (3–6 "- " items).',
    );
  }
  return result;
}

/* ---------- run ---------- */

async function run() {
  console.log(`Model: ${MODEL}  |  dry-run: ${argv['dry-run']}  |  overwrite: ${argv.overwrite}\n`);
  const products = await fetchProducts();
  console.log(`Fetched ${products.length} product(s).\n`);

  let updated = 0, skipped = 0, failed = 0;
  for (const p of products) {
    const a = p.attributes ?? p;
    const docId = p.documentId ?? a.documentId;
    const needs = argv.overwrite || isWeak(a.shortDescription) || isWeak(a.description);
    if (!needs) { skipped++; console.log(`–  ${a.name} (already has copy)`); continue; }

    try {
      const { shortDescription, description } = await generate(p);
      if (!shortDescription || !description) throw new Error('model returned empty fields');

      if (argv['dry-run']) {
        console.log(`\n=== ${a.name} ===`);
        console.log('shortDescription:', shortDescription);
        console.log('description:\n' + description + '\n');
      } else {
        await strapi(`/api/commerce-products/${docId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: { shortDescription, description } }),
        });
        console.log(`✓  ${a.name}`);
      }
      updated++;
    } catch (e) {
      failed++;
      console.error(`✖  ${a.name} — ${e.message}`);
    }
  }

  console.log(`\nDone. ${argv['dry-run'] ? 'previewed' : 'updated'}=${updated} skipped=${skipped} failed=${failed}`);
}

run().catch((e) => fatal(e.message));
