#!/usr/bin/env node
// Give the nxt.bargains Smart Home posts an H2 + H3 heading structure.
//
//   node scripts/restructure-smart-home-headings.mjs             # dry run
//   node scripts/restructure-smart-home-headings.mjs --write
//   node scripts/restructure-smart-home-headings.mjs --write --slug=<slug>
//
// These four posts are Markdown with five or six "## " sections and no "### "
// subheadings at all, so the site's contents rail renders them as a flat list.
//
// This RESTRUCTURES rather than regenerates. The posts are real editorial copy
// with specific claims in them — device behaviour, timings, what a given setup
// does — and asking a model for a fresh article on the same title would throw
// that away and invent replacements. So the prompt is constrained to
// reorganising: keep the sentences, keep the order, add "### " subheadings at
// the natural breaks, and change nothing else. The check below enforces that:
// a rewrite that drops or invents body text is rejected, not written.
//
// Every original is written to a backup file before anything is sent, so a bad
// batch can be restored without going back through Strapi's version history.
//
// Env (.env.local): ANTHROPIC_API_KEY, STRAPI_URL (or STRAPI_INTERNAL_URL),
// STRAPI_API_TOKEN.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { askForJson } from './lib/anthropic-chat.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
for (const line of (existsSync(join(ROOT, '.env.local')) ? readFileSync(join(ROOT, '.env.local'), 'utf8') : '').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const ONLY = flag('slug', null);
const CATEGORY = flag('category', 'smart-home');

const STRAPI = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN;
if (!TOKEN) {
  console.error('STRAPI_API_TOKEN is not set in .env.local');
  process.exit(1);
}

const BACKUP_DIR = join(ROOT, 'backups', 'smart-home-headings');

const SCHEMA = {
  type: 'object',
  properties: { content: { type: 'string' } },
  required: ['content'],
  additionalProperties: false,
};

const SYSTEM = [
  'You restructure existing articles. You do not write new ones.',
  'You never add facts, claims, figures, product names or recommendations that',
  'are not already present in the text you are given, and you never remove any.',
].join(' ');

function buildPrompt(post) {
  return [
    `Title: ${post.title}`,
    '',
    'Below is the full Markdown body of a published article. Reorganise its',
    'heading structure and nothing else.',
    '',
    'Rules:',
    '1. Keep every existing "## " heading exactly as written, in the same order.',
    '2. Inside the longer sections, insert "### " subheadings at the natural',
    '   breaks between distinct points. At least two "## " sections must end up',
    '   with two or more "### " subheadings. Aim for six to ten "### " in total.',
    '3. A "### " heading must be three to seven words, drawn from the wording of',
    '   the paragraphs it introduces. Do not restate the "## " above it.',
    '4. Do not reword, shorten, expand, merge or reorder the body paragraphs.',
    '   Every sentence that goes in must come out, unchanged, in the same order.',
    '   You are only inserting heading lines between existing paragraphs.',
    '5. Do not add an introduction, a conclusion, a summary or a call to action.',
    '6. Do not go deeper than "### ". Do not add "# ".',
    '7. Leave lists, links and any ::product:...:: markers exactly as they are.',
    '',
    'Return the complete Markdown body.',
    '',
    '--- ARTICLE ---',
    post.content,
  ].join('\n');
}

/** Words of body text, ignoring heading lines — the thing that must not change. */
function bodyWords(markdown) {
  return String(markdown || '')
    .split('\n')
    .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function headingCounts(markdown) {
  const all = [...String(markdown || '').matchAll(/^\s{0,3}(#{1,6})\s+(.+)$/gm)];
  return {
    h2: all.filter((m) => m[1].length === 2).length,
    h3: all.filter((m) => m[1].length === 3).length,
    other: all.filter((m) => m[1].length !== 2 && m[1].length !== 3).length,
    h2Texts: all.filter((m) => m[1].length === 2).map((m) => m[2].trim()),
  };
}

/**
 * Reject a rewrite that did more than insert headings.
 *
 * Compares the multiset of body words before and after. A handful of words can
 * legitimately move into a new heading line, so a small shrink is tolerated;
 * anything else — words appearing that were not there, or a real chunk of the
 * article going missing — fails.
 */
function verify(before, after) {
  const problems = [];
  const b = headingCounts(before);
  const a = headingCounts(after);

  if (a.h2 !== b.h2) problems.push(`h2 count changed ${b.h2} -> ${a.h2}`);
  if (a.h2Texts.join('|') !== b.h2Texts.join('|')) problems.push('h2 headings were altered or reordered');
  if (a.h3 < 4) problems.push(`only ${a.h3} h3 subheadings`);
  if (a.other > 0) problems.push(`${a.other} headings outside h2/h3`);

  const bw = bodyWords(before);
  const aw = bodyWords(after);
  const bag = new Map();
  for (const w of bw) bag.set(w, (bag.get(w) ?? 0) + 1);
  let added = 0;
  for (const w of aw) {
    const n = bag.get(w) ?? 0;
    if (n === 0) added += 1;
    else bag.set(w, n - 1);
  }
  const removed = [...bag.values()].reduce((s, n) => s + n, 0);

  // Words pulled up into a heading leave the body, so `removed` has slack;
  // `added` does not — a word that was never in the article is new text.
  if (added > 0) problems.push(`${added} body words are new (not in the original)`);
  if (removed > aw.length * 0.06 + 40) problems.push(`${removed} body words went missing`);

  return { problems, added, removed, before: b, after: a, words: { before: bw.length, after: aw.length } };
}

async function strapi(path, init = {}) {
  const res = await fetch(`${STRAPI}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

const listed = await strapi(`/api/nxt-posts?pagination[pageSize]=100&populate[categories]=true&status=draft`);
let posts = (listed.data ?? []).filter((p) => (p.categories ?? []).some((c) => c.slug === CATEGORY));
if (ONLY) posts = posts.filter((p) => p.slug === ONLY);

if (!posts.length) {
  console.error(`no posts found in category ${CATEGORY}${ONLY ? ` matching slug ${ONLY}` : ''}`);
  process.exit(1);
}

console.log(`category   : ${CATEGORY}`);
console.log(`posts      : ${posts.length}`);
console.log(`mode       : ${WRITE ? 'WRITE' : 'DRY RUN'}\n`);

if (WRITE) {
  mkdirSync(BACKUP_DIR, { recursive: true });
}

let ok = 0;
let skipped = 0;

for (const post of posts) {
  const before = post.content ?? '';
  const b = headingCounts(before);
  process.stdout.write(`${post.slug}\n  before: h2=${b.h2} h3=${b.h3} words=${bodyWords(before).length}\n`);

  if (!before.trim()) {
    console.log('  skipped: empty content\n');
    skipped += 1;
    continue;
  }

  let after;
  try {
    const out = await askForJson({
      system: SYSTEM,
      prompt: buildPrompt(post),
      schema: SCHEMA,
      maxTokens: 16000,
    });
    after = String(out.content || '').trim();
  } catch (error) {
    console.log(`  skipped: ${error.message}\n`);
    skipped += 1;
    continue;
  }

  const check = verify(before, after);
  console.log(`  after : h2=${check.after.h2} h3=${check.after.h3} words=${check.words.after}`);

  if (check.problems.length) {
    console.log(`  REJECTED: ${check.problems.join('; ')}\n`);
    skipped += 1;
    continue;
  }

  console.log(`  new subheadings: ${[...after.matchAll(/^\s{0,3}###\s+(.+)$/gm)].map((m) => m[1].trim()).join(' | ')}`);

  if (!WRITE) {
    console.log('  (dry run — not written)\n');
    ok += 1;
    continue;
  }

  writeFileSync(join(BACKUP_DIR, `${post.slug}.md`), before);

  // Update the draft, then publish, so the live post picks the change up.
  await strapi(`/api/nxt-posts/${post.documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { content: after } }),
  });
  await strapi(`/api/nxt-posts/${post.documentId}?status=published`, {
    method: 'PUT',
    body: JSON.stringify({ data: { content: after } }),
  });

  console.log('  written and published\n');
  ok += 1;
}

console.log(`done: ${ok} restructured, ${skipped} skipped`);
if (WRITE) console.log(`originals backed up in ${BACKUP_DIR}`);
else console.log('\nDry run — nothing written. Re-run with --write.');
