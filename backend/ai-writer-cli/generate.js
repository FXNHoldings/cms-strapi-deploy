#!/usr/bin/env node
// FXN AI Writer CLI
// Generates a travel article with Claude Sonnet 4.5 and posts it as a draft Article to Strapi.
//
// Usage:
//   node generate.js "Best cheap flights from London to Bangkok in 2026"
//   node generate.js --topic "..." --tone luxury --length long --destination Kyoto --category Hotels
//   node generate.js --topics topics.txt                   (batch mode, one topic per line)
//   node generate.js --topic "..." --dry-run               (print JSON only, don't hit Strapi)
//
// Each generated article is created as an UNPUBLISHED draft in Strapi.
// Review in the admin (Content Manager → Article), attach a cover image, then publish.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [topic] [options]')
  .option('topic', { alias: 't', type: 'string', describe: 'Article topic' })
  .option('topics', { type: 'string', describe: 'Path to a file with one topic per line' })
  .option('tone', { type: 'string', default: 'friendly', choices: ['friendly', 'professional', 'adventurous', 'witty', 'luxury'] })
  .option('length', { alias: 'l', type: 'string', default: 'medium', choices: ['short', 'medium', 'long'] })
  .option('destination', { alias: 'd', type: 'string', describe: 'Geographic destination (e.g. "Bangkok")' })
  .option('category', { alias: 'c', type: 'string', describe: 'Category name (e.g. "Flights")' })
  .option('keywords', { alias: 'k', type: 'string', describe: 'Comma-separated SEO keywords' })
  .option('language', { type: 'string', default: 'English' })
  .option('dry-run', { type: 'boolean', default: false, describe: "Don't POST to Strapi, just print the draft JSON" })
  .positional('topic-positional', { type: 'string' })
  .help()
  .parseSync();

// Allow positional topic: `node generate.js "Topic here"`
const positionalTopic = argv._[0];
if (!argv.topic && positionalTopic) argv.topic = String(positionalTopic);

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-5-20250929',
  CLAUDE_MAX_TOKENS = '4096',
  STRAPI_URL,
  STRAPI_API_TOKEN,
} = process.env;

if (!ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.');
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/** Build the JSON instructions for Claude. */
function systemPrompt(lengthLabel) {
  return `You are a senior travel journalist writing for a travel blog (flights, hotels, destinations, tips).
Output MUST be strict JSON matching this TypeScript type:
{
  "title": string,          // 50-70 chars, SEO-optimised
  "slug": string,           // kebab-case ASCII, <60 chars
  "excerpt": string,        // 140-180 chars, plain text, hook the reader
  "content": string,        // Markdown body, ${lengthLabel} words, with H2/H3 headings, bullet lists, and a strong closing CTA
  "seoTitle": string,       // <= 65 chars
  "seoDescription": string, // <= 158 chars
  "seoKeywords": string,    // comma-separated, 5-10 terms
  "tags": string[],         // 4-8 lowercase tags
  "readingTimeMinutes": number
}
Do not include any text outside the JSON. Do not wrap it in markdown fences. Use honest, specific, actionable advice — avoid generic tourist prose.`;
}

function userPrompt(params) {
  const wordsMap = { short: '400-600', medium: '800-1200', long: '1500-2200' };
  const words = wordsMap[params.length];
  return [
    `Topic: ${params.topic}`,
    params.destination ? `Destination: ${params.destination}` : '',
    params.category ? `Category: ${params.category}` : '',
    params.tone ? `Tone: ${params.tone}` : '',
    params.keywords ? `Keywords to weave in: ${params.keywords}` : '',
    params.language ? `Language: ${params.language}` : '',
    `Target length: ${words} words`,
  ].filter(Boolean).join('\n');
}

async function generate(params) {
  const lengthLabel = ({ short: '400-600', medium: '800-1200', long: '1500-2200' })[params.length];
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: parseInt(CLAUDE_MAX_TOKENS, 10),
    system: systemPrompt(lengthLabel),
    messages: [{ role: 'user', content: userPrompt(params) }],
  });

  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  if (!json) throw new Error(`Claude returned non-JSON output:\n${text.slice(0, 400)}`);

  if (!json.slug) json.slug = slugify(json.title || params.topic, { lower: true, strict: true }).slice(0, 60);
  return json;
}

async function postToStrapi(draft) {
  const res = await fetch(`${STRAPI_URL}/api/articles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    },
    body: JSON.stringify({
      data: {
        title: draft.title,
        slug: draft.slug,
        excerpt: draft.excerpt,
        content: draft.content,
        seoTitle: draft.seoTitle,
        seoDescription: draft.seoDescription,
        seoKeywords: draft.seoKeywords,
        readingTimeMinutes: draft.readingTimeMinutes,
        source: 'ai',
        // publishedAt omitted on purpose → stays as DRAFT
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strapi ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function safeParse(s) {
  try { return JSON.parse(s); }
  catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

function fatal(msg) {
  console.error('✖', msg);
  process.exit(1);
}

async function runOne(topic) {
  const params = {
    topic,
    tone: argv.tone,
    length: argv.length,
    destination: argv.destination,
    category: argv.category,
    keywords: argv.keywords,
    language: argv.language,
  };

  process.stdout.write(`→ Generating: "${topic}" … `);
  const t0 = Date.now();
  const draft = await generate(params);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  title: ${draft.title}`);
  console.log(`  slug:  ${draft.slug}`);
  console.log(`  words: ${(draft.content || '').split(/\s+/).length}`);

  if (argv['dry-run']) {
    console.log('\n— draft JSON (dry-run) —');
    console.log(JSON.stringify(draft, null, 2));
    return;
  }

  process.stdout.write('  posting draft to Strapi … ');
  const created = await postToStrapi(draft);
  const id = created?.data?.id || created?.data?.documentId || '?';
  console.log(`saved (id=${id}, draft)`);
  console.log(`  review: ${STRAPI_URL}/admin/content-manager/collection-types/api::article.article/${id}`);
}

async function main() {
  if (argv.topics) {
    const file = path.resolve(argv.topics);
    if (!fs.existsSync(file)) fatal(`Topics file not found: ${file}`);
    const topics = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!topics.length) fatal('No topics found in file');
    console.log(`Batch mode: ${topics.length} topics\n`);
    let ok = 0, fail = 0;
    for (const t of topics) {
      try { await runOne(t); ok++; } catch (e) { console.error(`  ✖ ${e.message}`); fail++; }
      console.log('');
    }
    console.log(`\nDone — ${ok} created, ${fail} failed.`);
    return;
  }

  if (!argv.topic) fatal('No topic provided. Usage: node generate.js "Your topic here"  (or use --topics file)');
  await runOne(argv.topic);
}

main().catch((e) => {
  console.error('\n✖', e.message);
  process.exit(1);
});
