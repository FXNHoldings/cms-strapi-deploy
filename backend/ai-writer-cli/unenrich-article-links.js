#!/usr/bin/env node
// FXN — Strip internal links previously inserted by enrich-article-links.js.
//
// The enricher only ever creates markdown links to:
//   /destinations/<slug>
//   /airlines/<slug>
//   https://<tp-host>/?marker=...        (only when --tp-airlines was used)
//
// This script reverses that: it replaces `[text](/destinations/...)` and
// `[text](/airlines/...)` (and optionally the Aviasales affiliate variant
// with --include-tp) with the bare `text`, then PUTs the cleaned content
// back to Strapi. Idempotent — safe to re-run.
//
// Other markdown links (external URLs the author wrote, mailto:, anchors)
// are untouched.
//
// Usage:
//   node unenrich-article-links.js --dry-run --verbose
//   node unenrich-article-links.js --slug bali-jungle-hotels
//   node unenrich-article-links.js --category hotels
//   node unenrich-article-links.js                # apply across every article
//   node unenrich-article-links.js --include-tp   # also strip Aviasales links

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, describe: 'Print proposed removals, write nothing' })
  .option('slug', { type: 'string', describe: 'Only process this article slug' })
  .option('category', { alias: 'c', type: 'string', describe: 'Only process articles in this category (slug). Comma-separated for multiple.' })
  .option('limit', { type: 'number', describe: 'Only process the first N articles' })
  .option('include-tp', { type: 'boolean', default: false, describe: 'Also strip Aviasales/Travelpayouts affiliate links (URLs containing marker=). Default off.' })
  .option('verbose', { alias: 'v', type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');

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

/* ---------- Stripping ---------- */

// Matches `[text](/destinations/<slug>)` or `[text](/airlines/<slug>)`.
// Captures the link text in group 1 and the kind in group 2.
const INTERNAL_LINK_RE = /\[([^\]]+)\]\(\/(destinations|airlines)\/[^)\s]+\)/g;

// Matches `[text](https://anything?...marker=...)` — Aviasales/TP affiliate
// pattern produced by the enricher's --tp-airlines mode.
const TP_LINK_RE = /\[([^\]]+)\]\(https?:\/\/[^)]*[?&]marker=[^)]*\)/g;

function stripLinks(content) {
  const removed = [];
  let next = content.replace(INTERNAL_LINK_RE, (match, text, kind) => {
    removed.push({ kind, match, text });
    return text;
  });
  if (argv['include-tp']) {
    next = next.replace(TP_LINK_RE, (match, text) => {
      removed.push({ kind: 'tp', match, text });
      return text;
    });
  }
  return { content: next, removed };
}

/* ---------- Main ---------- */

async function main() {
  const log = (...args) => console.log(...args);

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

  const stats = { processed: 0, modified: 0, totalRemoved: 0, errors: 0 };

  for (const a of articles) {
    stats.processed++;
    if (!a.content || typeof a.content !== 'string') {
      if (argv.verbose) log(`  [skip] ${a.slug} — empty content`);
      continue;
    }
    const { content: next, removed } = stripLinks(a.content);
    if (removed.length === 0) {
      if (argv.verbose) log(`  [—] ${a.slug} — no enricher links`);
      continue;
    }
    stats.modified++;
    stats.totalRemoved += removed.length;
    log(`  [-${removed.length}] ${a.slug}`);
    if (argv.verbose || argv['dry-run']) {
      for (const r of removed) {
        log(`        · ${r.kind.padEnd(12)} "${r.text}"`);
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
  log(`  processed:    ${stats.processed}`);
  log(`  modified:     ${stats.modified}${argv['dry-run'] ? ' (dry run, no writes)' : ''}`);
  log(`  links removed: ${stats.totalRemoved}`);
  if (stats.errors) log(`  errors:       ${stats.errors}`);
}

function fatal(msg) { console.error('✖', msg); process.exit(1); }

main().catch((e) => fatal(e.stack || e.message));
