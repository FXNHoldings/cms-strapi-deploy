#!/usr/bin/env node
/**
 * Generate product descriptions for BLS products via the Anthropic API.
 *
 * For each product (or a single product when SLUG is set):
 *   1. Skip if `description` already meets MIN_LENGTH (unless FORCE=1).
 *   2. Build a prompt from name + brand + keyFeatures + ingredients +
 *      shortDescription. Ask Claude for ~150-220 words of markdown copy:
 *      one short opening line, then 1-2 paragraphs covering what the product
 *      does, who it's for, and any standout ingredient notes.
 *   3. PUT the result into Strapi's `description` field.
 *
 * Cost: ~$0.003 per product on Sonnet (~700 in / ~300 out tokens).
 *       60 products → ~$0.18.
 *
 * Required env:
 *   STRAPI_URL              default: http://127.0.0.1:8888
 *   STRAPI_TOKEN            REQUIRED
 *   ANTHROPIC_API_KEY       REQUIRED
 *
 * Optional env:
 *   CLAUDE_MODEL            default: claude-sonnet-4-5-20250929
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

const STRAPI_URL = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE = process.env.FORCE === '1';
const SLUG = process.env.SLUG || '';
const MIN_LENGTH = process.env.MIN_LENGTH ? parseInt(process.env.MIN_LENGTH, 10) : 300;
const CONCURRENCY = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 3;
const VERBOSE = process.env.VERBOSE === '1';

if (!STRAPI_TOKEN) abort('STRAPI_TOKEN env var is required');
if (!ANTHROPIC_KEY) abort('ANTHROPIC_API_KEY env var is required');

function abort(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Strapi
// --------------------------------------------------------------------------
async function strapi(path, init = {}) {
  const r = await fetch(`${STRAPI_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${STRAPI_TOKEN}`,
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
  const body = {
    model: CLAUDE_MODEL,
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
  console.log(`▶ generating descriptions via ${CLAUDE_MODEL}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const all = await listProducts();
  const candidates = all.filter((p) => {
    if (FORCE) return true;
    const cur = (p.description || '').trim();
    return cur.length < MIN_LENGTH;
  });
  if (LIMIT > 0 && candidates.length > LIMIT) candidates.length = LIMIT;

  console.log(`  ${all.length} products total · ${candidates.length} need a description\n`);

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
      await updateProduct(p.documentId, { description, keyFeatures });
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
