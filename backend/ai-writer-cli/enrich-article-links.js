#!/usr/bin/env node
// FXN — Scan every Strapi article and auto-insert internal links for known
// destinations and airlines (e.g. "Qantas" → /airlines/qantas, "Bangkok" →
// /destinations/bangkok).
//
// Strategy:
//   1. Pull all destinations + airlines from Strapi → build a term map.
//   2. For each article, protect code fences, inline code, headings, existing
//      markdown links and images, then replace the first occurrence of each
//      matched term with [term](url). Longest terms run first so
//      "Bangkok Airways" wins over "Bangkok".
//   3. PUT the updated `content` back, capped at --max-links per article.
//
// Idempotent: skips any term whose target URL is already linked in the body.
//
// Usage:
//   node enrich-article-links.js --dry-run                 # preview all
//   node enrich-article-links.js --slug bali-jungle-hotels # one article
//   node enrich-article-links.js --limit 5                 # first 5 only
//   node enrich-article-links.js --no-destinations         # airlines only
//   node enrich-article-links.js                           # apply all

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, describe: 'Print proposed links, write nothing' })
  .option('slug', { type: 'string', describe: 'Only process this article slug' })
  .option('category', { alias: 'c', type: 'string', describe: 'Only process articles in this category (slug). Comma-separated for multiple, e.g. "hotels,flights"' })
  .option('limit', { type: 'number', describe: 'Only process the first N articles' })
  .option('max-links', { type: 'number', default: 10, describe: 'Max NEW links to insert per article' })
  .option('min-term-length', { type: 'number', default: 4, describe: 'Skip terms shorter than this' })
  .option('destinations', { type: 'boolean', default: true, describe: 'Link destinations (use --no-destinations to skip)' })
  .option('airlines', { type: 'boolean', default: true, describe: 'Link airlines (use --no-airlines to skip)' })
  .option('verbose', { alias: 'v', type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');

// Generic English words that happen to equal destination/airline names.
// Skip them so we don't carpet articles with noise links.
const STOPWORDS = new Set([
  'travel', 'hotel', 'hotels', 'flight', 'flights', 'airline', 'airlines',
  'city', 'island', 'beach', 'tour', 'tours', 'guide', 'world', 'south',
  'north', 'east', 'west', 'international', 'central', 'union', 'national',
  'royal', 'gold', 'silver', 'sun', 'star', 'crown',
]);

/* ---------- Strapi ---------- */

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
    const body = await res.text().catch(() => '');
    throw new Error(`Strapi ${res.status} on ${pathname}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchAll(endpoint, fields, extraQs = []) {
  const all = [];
  let page = 1;
  const pageSize = 100;
  for (;;) {
    const qs = new URLSearchParams();
    qs.append('pagination[page]', String(page));
    qs.append('pagination[pageSize]', String(pageSize));
    fields.forEach((f, i) => qs.append(`fields[${i}]`, f));
    qs.append('sort[0]', 'id:asc');
    for (const [k, v] of extraQs) qs.append(k, v);
    const res = await strapi(`/api/${endpoint}?${qs.toString()}`);
    all.push(...(res.data || []));
    const total = res.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page++;
  }
  return all;
}

/* ---------- Term map ---------- */

function buildTerms({ destinations, airlines }) {
  const seen = new Map(); // normalised term → entry (first wins after sorting)
  const add = (term, url, kind) => {
    if (!term || !url) return;
    const t = term.trim();
    if (t.length < argv['min-term-length']) return;
    if (STOPWORDS.has(t.toLowerCase())) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.set(key, { term: t, url, kind, len: t.length });
  };
  if (argv.destinations) {
    for (const d of destinations) {
      if (d.name && d.slug) add(d.name, `/destinations/${d.slug}`, 'destination');
    }
  }
  if (argv.airlines) {
    for (const a of airlines) {
      if (a.name && a.slug) add(a.name, `/airlines/${a.slug}`, 'airline');
    }
  }
  // Longest first so "Bangkok Airways" wins over "Bangkok".
  return Array.from(seen.values()).sort((a, b) => b.len - a.len);
}

/* ---------- Link insertion ---------- */

const PROTECTED_PATTERNS = [
  /^---\n[\s\S]*?\n---\n/,        // frontmatter (rarely present)
  /```[\s\S]*?```/g,              // fenced code
  /`[^`\n]+`/g,                   // inline code
  /!\[[^\]]*\]\([^)]*\)/g,        // images
  /\[[^\]]*\]\([^)]*\)/g,         // existing links
  /^#{1,6} .*$/gm,                // ATX headings
];

function maskProtected(content) {
  const stash = [];
  let s = content;
  for (const pat of PROTECTED_PATTERNS) {
    s = s.replace(pat, (m) => {
      const i = stash.length;
      stash.push(m);
      return `\x00${i}\x00`;
    });
  }
  return { masked: s, stash };
}

function unmask(masked, stash) {
  return masked.replace(/\x00(\d+)\x00/g, (_, i) => stash[+i]);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function insertLinks(content, terms, maxLinks) {
  let { masked, stash } = maskProtected(content);
  const inserted = [];
  for (const t of terms) {
    if (inserted.length >= maxLinks) break;
    // Skip if this URL is already linked anywhere in the article.
    if (content.includes(`](${t.url})`)) continue;
    // Multi-word terms can match case-insensitively (collision risk is low —
    // "Singapore Airlines" rarely appears as common prose). Single-word terms
    // require an exact-case match so common English words like "level",
    // "first", "trade", "villa" — which happen to be airline names — don't
    // get linked when they appear lowercase in the article body.
    const isMultiWord = /\s/.test(t.term);
    const re = new RegExp(`\\b${escapeRegex(t.term)}\\b`, isMultiWord ? 'i' : '');
    const m = masked.match(re);
    if (!m) continue;
    const matched = m[0]; // preserve original casing
    const link = `[${matched}](${t.url})`;
    const i = stash.length;
    stash.push(link);
    masked = masked.replace(re, `\x00${i}\x00`);
    inserted.push({ term: t.term, matched, url: t.url, kind: t.kind });
  }
  return { content: unmask(masked, stash), inserted };
}

/* ---------- Main ---------- */

async function main() {
  const log = (...args) => console.log(...args);

  log(`▸ Loading destinations + airlines from Strapi …`);
  const [destinations, airlines] = await Promise.all([
    argv.destinations ? fetchAll('destinations', ['id', 'name', 'slug']) : [],
    argv.airlines ? fetchAll('airlines', ['id', 'name', 'slug']) : [],
  ]);
  log(`  destinations: ${destinations.length}   airlines: ${airlines.length}`);

  const terms = buildTerms({ destinations, airlines });
  log(`  built ${terms.length} unique terms (min length ${argv['min-term-length']})\n`);

  const categoryFilter = argv.category
    ? argv.category.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const categoryQs = categoryFilter.map((slug, i) => [`filters[category][slug][$in][${i}]`, slug]);

  log(`▸ Loading articles${categoryFilter.length ? ` (category: ${categoryFilter.join(', ')})` : ''} …`);
  let articles;
  if (argv.slug) {
    const qs = new URLSearchParams();
    qs.append('filters[slug][$eq]', argv.slug);
    qs.append('fields[0]', 'id');
    qs.append('fields[1]', 'documentId');
    qs.append('fields[2]', 'title');
    qs.append('fields[3]', 'slug');
    qs.append('fields[4]', 'content');
    for (const [k, v] of categoryQs) qs.append(k, v);
    const res = await strapi(`/api/articles?${qs.toString()}`);
    articles = res.data || [];
  } else {
    articles = await fetchAll('articles', ['id', 'documentId', 'title', 'slug', 'content'], categoryQs);
  }
  if (argv.limit) articles = articles.slice(0, argv.limit);
  log(`  ${articles.length} article(s) to process${argv['dry-run'] ? ' (DRY RUN)' : ''}\n`);

  const stats = { processed: 0, modified: 0, totalLinks: 0, errors: 0 };

  for (const a of articles) {
    stats.processed++;
    if (!a.content || typeof a.content !== 'string') {
      log(`  [skip] ${a.slug} — empty content`);
      continue;
    }
    const { content: next, inserted } = insertLinks(a.content, terms, argv['max-links']);
    if (inserted.length === 0) {
      if (argv.verbose) log(`  [—] ${a.slug} — no new links`);
      continue;
    }
    stats.modified++;
    stats.totalLinks += inserted.length;
    log(`  [+${inserted.length}] ${a.slug}`);
    if (argv.verbose || argv['dry-run']) {
      for (const ins of inserted) {
        log(`        · ${ins.kind.padEnd(11)} "${ins.matched}" → ${ins.url}`);
      }
    }
    if (argv['dry-run']) continue;
    try {
      const target = a.documentId ?? a.id;
      await strapi(`/api/articles/${target}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { content: next } }),
      });
    } catch (err) {
      stats.errors++;
      console.error(`  ✖ ${a.slug} — ${err.message}`);
    }
  }

  log(`\n=== Done ===`);
  log(`  processed:  ${stats.processed}`);
  log(`  modified:   ${stats.modified}${argv['dry-run'] ? ' (dry run, no writes)' : ''}`);
  log(`  new links:  ${stats.totalLinks}`);
  if (stats.errors) log(`  errors:     ${stats.errors}`);
}

function fatal(msg) { console.error('✖', msg); process.exit(1); }

main().catch((e) => fatal(e.stack || e.message));
