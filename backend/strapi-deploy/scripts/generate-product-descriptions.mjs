#!/usr/bin/env node
/**
 * Generate product descriptions for BLS products via the Anthropic API.
 *
 * For each product (or a single product when SLUG is set):
 *   1. Skip if this script already generated the description (descriptionGeneratedAt
 *      or the ### Overview / ### Key Features / ### Benefits template), unless FORCE=1.
 *   2. Also skip when `description` already meets MIN_LENGTH (unless FORCE=1).
 *   3. Build a prompt from name + brand + keyFeatures + ingredients +
 *      shortDescription. Ask Claude for ~150-220 words of markdown copy:
 *      one short opening line, then 1-2 paragraphs covering what the product
 *      does, who it's for, and any standout ingredient notes.
 *   4. PUT the result into Strapi's `description` field and stamp
 *      `descriptionGeneratedAt` so reruns can skip it.
 *
 * Cost: ~$0.003 per product on Sonnet (~700 in / ~300 out tokens).
 *       60 products → ~$0.18.
 *
 * Required env:
 *   STRAPI_URL              default: http://127.0.0.1:8888
 *   OPENROUTER_API_KEY      preferred for anthropic/claude-opus-4-8
 *   ANTHROPIC_API_KEY       fallback direct Anthropic API
 *
 * Strapi auth (auto-loaded from ../.env when present):
 *   STRAPI_TOKEN | STRAPI_API_TOKEN | AUTOPOST_STRAPI_TOKEN
 *   Required only when writing to Strapi (not needed for DRY_RUN=1 previews).
 *
 * Optional env:
 *   CLAUDE_MODEL            default: anthropic/claude-opus-4-8
 *   OPENROUTER_MODEL        alias for CLAUDE_MODEL when using OpenRouter
 *   LIMIT                   cap product count
 *   DRY_RUN=1               print generated copy but don't write to Strapi
 *   FORCE=1                 regenerate even when a description exists
 *   SLUG=<slug>             process one product by slug
 *   MIN_LENGTH=300          treat descriptions shorter than this as missing
 *   CONCURRENCY=3           parallel Anthropic calls (default 3)
 *   VERBOSE=1               print full prompt + response for debugging
 *
 * Usage:
 *   STRAPI_TOKEN=... ANTHROPIC_API_KEY=... \
 *     node scripts/generate-product-descriptions.mjs
 *
 *   # one product
 *   SLUG=cerave-hydrating-toner-... node scripts/generate-product-descriptions.mjs
 *
 *   # rewrite everything
 *   FORCE=1 node scripts/generate-product-descriptions.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, '..');
loadEnv(resolve(APP_DIR, '.env'));
loadEnv(resolve(APP_DIR, '.env.local'));

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN =
  process.env.STRAPI_TOKEN ||
  process.env.STRAPI_API_TOKEN ||
  process.env.AUTOPOST_STRAPI_TOKEN ||
  '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.CLAUDE_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4-8';
const USE_OPENROUTER = Boolean(OPENROUTER_API_KEY);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === '1';
const SLUG = process.env.SLUG || '';
const MIN_LENGTH = process.env.MIN_LENGTH ? parseInt(process.env.MIN_LENGTH, 10) : 300;
const CONCURRENCY = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 3;
const VERBOSE = process.env.VERBOSE === '1';
const GENERATED_SECTIONS = [/###\s*Overview\b/i, /###\s*Key Features\b/i, /###\s*Benefits\b/i];

if (!USE_OPENROUTER && !ANTHROPIC_KEY) {
  abort('OPENROUTER_API_KEY or ANTHROPIC_API_KEY env var is required');
}

function abort(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function looksLikeGeneratedDescription(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return GENERATED_SECTIONS.every((pattern) => pattern.test(value));
}

function hasGeneratedDescription(product) {
  if (product.descriptionGeneratedAt) return true;
  return looksLikeGeneratedDescription(product.description);
}

function needsDescription(product) {
  if (FORCE) return true;
  if (hasGeneratedDescription(product)) return false;
  const current = String(product.description || '').trim();
  return current.length < MIN_LENGTH;
}

// --------------------------------------------------------------------------
// Strapi
// --------------------------------------------------------------------------
async function strapi(path, init = {}) {
  const r = await fetch(`${STRAPI_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Strapi ${init.method || 'GET'} ${path} → ${r.status}: ${txt.slice(0, 240)}`);
  }
  return r.json();
}

async function listProducts() {
  if (SLUG) {
    const r = await strapi(
      `/api/bls-products?filters[slug][$eq]=${encodeURIComponent(SLUG)}&pagination[pageSize]=1`,
    );
    return r.data || [];
  }
  const all = [];
  let page = 1;
  for (;;) {
    const r = await strapi(`/api/bls-products?pagination[page]=${page}&pagination[pageSize]=100`);
    const items = r.data || [];
    if (items.length === 0) break;
    all.push(...items);
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page += 1;
  }
  return all;
}

async function updateProduct(documentId, patch) {
  if (DRY_RUN) return;
  if (!STRAPI_TOKEN) abort('Strapi token required to write. Set STRAPI_TOKEN, STRAPI_API_TOKEN, or AUTOPOST_STRAPI_TOKEN.');
  await strapi(`/api/bls-products/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: patch }),
  });
}

// --------------------------------------------------------------------------
// Anthropic API — direct fetch, no SDK dependency
// --------------------------------------------------------------------------
const SYSTEM_PROMPT = `You write product copy for a skincare review blog called BestLooking.Skin.

You MUST output a single valid JSON object — no preamble, no commentary,
no markdown code fences. The object has exactly two keys:

  "keyFeatures": array of 3–4 short factual bullet strings (max 4).
                 Each is a single line, ≤ 100 chars, no leading dash, no
                 trailing period required. One concrete fact per bullet
                 (ingredient, formulation, certification, audience). No
                 marketing slogans.

  "description": markdown string with EXACTLY three sections, each starting
                 with a "### " heading. Use these literal headings in this
                 exact order:

                   ### Overview
                   One short hook line, then one paragraph (2–4 sentences)
                   covering what the product is, the form factor, and who
                   it's for.

                   ### Key Features
                   A markdown bullet list (lines starting with "- ").
                   Use the same 3–4 bullets as the keyFeatures array, but
                   you may rephrase or lightly expand each one for readability.

                   ### Benefits
                   One paragraph (2–4 sentences) explaining the benefits
                   the user can expect and how this product fits into a
                   routine. Stay factual: explain WHY the ingredients /
                   features in the bullets matter for the skin.

GLOBAL VOICE & RULES
- 180–260 words in the description across all three sections.
- Conversational, factual, second-person where natural ("your skin").
- No marketing puffery. No medical claims. No words like "miracle",
  "revolutionary", "best ever". No exclamation points.
- Don't invent specs (sizes, prices, ingredient percentages) that aren't
  in the source data.
- Don't repeat the product name more than twice in the description.
  Refer to it by category ("the cleanser", "this serum") afterwards.
- Output ONLY the JSON object. No prose, no code fences.`;

function buildUserPrompt(p) {
  const lines = [];
  lines.push(`Write a description for this product.`);
  lines.push('');
  lines.push(`Product name: ${p.name}`);
  if (p.brand) lines.push(`Brand: ${p.brand}`);
  if (p.shortDescription) {
    lines.push(`Short description: ${p.shortDescription}`);
  }
  if (Array.isArray(p.keyFeatures) && p.keyFeatures.length) {
    lines.push('');
    lines.push('Key features (use these as factual basis — do not invent extras):');
    for (const f of p.keyFeatures.slice(0, 12)) {
      lines.push(`- ${String(f).slice(0, 240)}`);
    }
  }
  if (p.ingredients) {
    lines.push('');
    lines.push(`Notable ingredients: ${String(p.ingredients).slice(0, 400)}`);
  }
  if (Array.isArray(p.skinTypes) && p.skinTypes.length) {
    lines.push(`Skin types: ${p.skinTypes.join(', ')}`);
  }
  return lines.join('\n');
}

async function callClaude(userPrompt) {
  if (USE_OPENROUTER) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://bestlooking.skin',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'BLS Product Descriptions',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 1200,
        temperature: 0.35,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`OpenRouter ${r.status}: ${txt.slice(0, 300)}`);
    }
    const j = await r.json();
    const text = String(j.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('Empty response from OpenRouter');
    return { text, usage: j.usage };
  }

  const body = {
    model: AI_MODEL,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 300)}`);
  }
  const j = await r.json();
  const text = (j.content || []).map((c) => c.text || '').join('').trim();
  if (!text) throw new Error('Empty response from Claude');
  return { text, usage: j.usage };
}

// Defensive JSON extractor — model occasionally emits a code fence or stray
// text despite the system prompt. Pull the first {...} block and parse it.
function parseClaudeJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in response: ${text.slice(0, 120)}`);
  }
  const slice = text.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}. First 120 chars: ${slice.slice(0, 120)}`);
  }
  const description = String(parsed.description || '').trim();
  let keyFeatures = Array.isArray(parsed.keyFeatures) ? parsed.keyFeatures : [];
  keyFeatures = keyFeatures
    .map((f) => String(f).replace(/^[\s\-•*]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!description) throw new Error('Response had empty "description"');
  if (keyFeatures.length === 0) throw new Error('Response had empty "keyFeatures"');
  return { description, keyFeatures };
}

// --------------------------------------------------------------------------
// Concurrency-limited runner
// --------------------------------------------------------------------------
async function runPool(items, worker, concurrency) {
  const results = [];
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
async function main() {
  console.log(`▶ generating descriptions via ${AI_MODEL}${DRY_RUN ? ' (DRY RUN)' : ''}${USE_OPENROUTER ? ' [openrouter]' : ' [anthropic]'}`);

  const all = await listProducts();
  const candidates = all.filter(needsDescription);
  const skippedGenerated = FORCE
    ? 0
    : all.filter((product) => hasGeneratedDescription(product)).length;
  if (LIMIT > 0 && candidates.length > LIMIT) candidates.length = LIMIT;

  console.log(
    `  ${all.length} products total · ${candidates.length} need a description` +
    (skippedGenerated ? ` · ${skippedGenerated} already generated` : '') +
    '\n',
  );

  let written = 0, errored = 0, totalIn = 0, totalOut = 0;

  await runPool(candidates, async (p) => {
    const prompt = buildUserPrompt(p);
    if (VERBOSE) console.log(`\n--- ${p.slug} prompt ---\n${prompt}`);
    try {
      const { text, usage } = await callClaude(prompt);
      if (VERBOSE) console.log(`\n--- ${p.slug} raw response ---\n${text}\n`);
      totalIn += usage?.input_tokens ?? 0;
      totalOut += usage?.output_tokens ?? 0;
      const { description, keyFeatures } = parseClaudeJson(text);
      await updateProduct(p.documentId, {
        description,
        keyFeatures,
        descriptionGeneratedAt: new Date().toISOString(),
      });
      written += 1;
      console.log(`  ✓ ${p.slug}: ${description.length} chars · ${keyFeatures.length} features`);
    } catch (err) {
      errored += 1;
      console.error(`  ! ${p.slug}: ${err.message}`);
    }
  }, CONCURRENCY);

  // Sonnet pricing as of writing: $3/MTok input, $15/MTok output.
  const cost = (totalIn / 1_000_000) * 3 + (totalOut / 1_000_000) * 15;
  console.log(
    `\nDone. written=${written} errored=${errored} ` +
    `tokens=${totalIn}in/${totalOut}out cost≈$${cost.toFixed(3)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
