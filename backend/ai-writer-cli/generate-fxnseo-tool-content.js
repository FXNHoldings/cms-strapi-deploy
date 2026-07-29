#!/usr/bin/env node
// Auto-generate on-page SEO content (subheading + short description + description)
// for each fxnSEOTools SEO tool page, and write it into the SumoSEO app
// (page_translations) via sumoseo-update-tool.php.
//
// The "Heading" stays the tool name (already set as the page title); this fills
// the empty subtitle / short_description / description fields.
//
// Usage:
//   node generate-fxnseo-tool-content.js                 # all tools, skip populated
//   node generate-fxnseo-tool-content.js --only backlink-checker
//   node generate-fxnseo-tool-content.js --limit 5 --dry-run
//   node generate-fxnseo-tool-content.js --overwrite     # regenerate everything

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseAiJson } from './parse-ai-json.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const SITE_URL = 'https://fxnseo.com';
const TOOLS_FILE = path.join(SCRIPT_DIR, 'fxnseo-tools.json');
const SUMOSEO_APP_DIR = process.env.SUMOSEO_APP_DIR || '/var/www/html/fxnseo.com/components';
const UPDATER = path.join(SUMOSEO_APP_DIR, 'sumoseo-update-tool.php');
const RUN_AS = process.env.SUMOSEO_RUN_AS || 'www-data';

const argv = yargs(hideBin(process.argv))
  .option('only', { type: 'string', describe: 'Only this tool slug' })
  .option('limit', { type: 'number', describe: 'Process at most N tools' })
  .option('overwrite', { type: 'boolean', default: false, describe: 'Regenerate even if content already exists' })
  .option('language', { type: 'string', default: 'English' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Print generated content; do not write to the DB' })
  .help()
  .parseSync();

const {
  AI_PROVIDER = 'openai',
  OPENAI_API_KEY, OPENAI_MODEL = 'gpt-5.5', OPENAI_MAX_OUTPUT_TOKENS = '16000',
  OPENROUTER_API_KEY, OPENROUTER_MODEL = '~openai/gpt-latest', OPENROUTER_MAX_TOKENS = '16000',
  OPENROUTER_SITE_URL = 'https://fxnseo.com', OPENROUTER_APP_NAME = 'FXN AI Writer CLI',
  ANTHROPIC_API_KEY, CLAUDE_MODEL = 'claude-sonnet-4-5-20250929', CLAUDE_MAX_TOKENS = '16000',
} = process.env;

const aiProvider = AI_PROVIDER.toLowerCase();
if (aiProvider === 'openai' && !OPENAI_API_KEY) fatal('OPENAI_API_KEY is not set.');
if (aiProvider === 'openrouter' && !OPENROUTER_API_KEY) fatal('OPENROUTER_API_KEY is not set.');
if (aiProvider === 'anthropic' && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set.');

const anthropicClient = aiProvider === 'anthropic' ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const openaiClient = aiProvider === 'openai' ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const openrouterClient = aiProvider === 'openrouter'
  ? new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
  : null;

function loadTools() {
  const tools = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
  let list = Array.isArray(tools) ? tools : [];
  if (argv.only) list = list.filter((t) => t.slug === argv.only);
  if (argv.limit) list = list.slice(0, argv.limit);
  return list;
}

async function generateToolContent(tool) {
  const prompt = `You are writing on-page SEO content for the "${tool.name}" tool on fxnSEOTools (${SITE_URL}/${tool.slug}), a free online SEO tools platform.

Language: ${argv.language}

Return STRICT JSON only with exactly these keys:
{
  "subtitle": string,
  "shortDescription": string,
  "description": string
}

Field requirements:
- "subtitle": a short, benefit-driven subheading/tagline for the "${tool.name}". <= 110 characters, no trailing period.
- "shortDescription": a plain-text 1-2 sentence summary of what the "${tool.name}" does. <= 280 characters.
- "description": Markdown body, 250-450 words. Explain what the "${tool.name}" does, why it matters for SEO, how to use it (a few short steps), and its key features/benefits. Use H2/H3 headings. End with a one-sentence call to action to use it free on fxnSEOTools. No markdown code fences.

Rules:
- Be accurate to what a "${tool.name}" genuinely does. Do not invent fake metrics, prices, or guarantees.
- Professional, helpful tone. No fluff.`;

  const text = await callAI({
    system: 'You are a senior SEO copywriter. Return strict JSON only.',
    user: prompt,
    maxTokens: Math.max(Number(maxTokens()) || 0, 4000),
  });
  const parsed = parseAiJson(text, { providerName: activeProviderName() });
  if (!parsed?.subtitle || !parsed?.description) {
    throw new Error(`${activeProviderName()} response missing subtitle/description`);
  }
  return parsed;
}

async function writeToDb(tool, content) {
  const payload = {
    slug: tool.slug,
    subtitle: String(content.subtitle || '').trim(),
    short_description: String(content.shortDescription || '').trim(),
    description: String(content.description || '').trim(),
    overwrite: !!argv.overwrite,
  };
  const tmp = path.join(os.tmpdir(), `fxnseo-tool-${tool.slug}-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.chmodSync(tmp, 0o644);
  try {
    const { stdout } = await execFileAsync('sudo', ['-u', RUN_AS, 'php', UPDATER, tmp], {
      cwd: SUMOSEO_APP_DIR, maxBuffer: 1024 * 1024,
    });
    const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
    const result = JSON.parse(line);
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function run() {
  const tools = loadTools();
  if (!tools.length) fatal('No tools matched.');
  console.log(`fxnSEOTools tool-content generator — ${tools.length} tool(s)`);
  console.log(`AI: ${aiProvider} | Model: ${activeModel()} | overwrite: ${argv.overwrite} | dry-run: ${argv['dry-run']}\n`);

  let done = 0; let skipped = 0; let failed = 0;
  for (const [i, tool] of tools.entries()) {
    process.stdout.write(`[${i + 1}/${tools.length}] ${tool.name} (${tool.slug}) ... `);
    try {
      const content = await generateToolContent(tool);
      if (argv['dry-run']) {
        process.stdout.write('generated (dry-run)\n');
        console.log(JSON.stringify(content, null, 2));
        done += 1;
        continue;
      }
      const res = await writeToDb(tool, content);
      if (res.skipped) { process.stdout.write('skipped (already has content)\n'); skipped += 1; }
      else { process.stdout.write('updated\n'); done += 1; }
    } catch (error) {
      process.stdout.write(`FAILED: ${error.message.slice(0, 140)}\n`);
      failed += 1;
    }
  }
  console.log(`\nDone. updated=${done} · skipped=${skipped} · failed=${failed}`);
}

// --- AI plumbing ---
async function callAI({ system, user, maxTokens }) {
  if (aiProvider === 'openai') {
    const r = await openaiClient.responses.create({ model: OPENAI_MODEL, instructions: system, input: user, max_output_tokens: maxTokens });
    return r.output_text?.trim() || '';
  }
  if (aiProvider === 'openrouter') {
    const c = await openrouterClient.chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      extra_headers: { 'HTTP-Referer': OPENROUTER_SITE_URL, 'X-OpenRouter-Title': OPENROUTER_APP_NAME },
    });
    return c.choices?.[0]?.message?.content?.trim() || '';
  }
  const m = await anthropicClient.messages.create({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}
function activeModel() { return aiProvider === 'openai' ? OPENAI_MODEL : aiProvider === 'openrouter' ? OPENROUTER_MODEL : CLAUDE_MODEL; }
function activeProviderName() { return aiProvider === 'openai' ? 'OpenAI' : aiProvider === 'openrouter' ? 'OpenRouter' : 'Claude'; }
function maxTokens() { return aiProvider === 'openai' ? OPENAI_MAX_OUTPUT_TOKENS : aiProvider === 'openrouter' ? OPENROUTER_MAX_TOKENS : CLAUDE_MAX_TOKENS; }
function fatal(msg) { console.error('✖', msg); process.exit(1); }

run().catch((e) => fatal(e.message));
