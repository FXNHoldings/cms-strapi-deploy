#!/usr/bin/env node
// FXN — Scan every Strapi article and auto-insert links for known terms.
//
// Four link types, each independently toggleable:
//   • destinations  → /destinations/<slug>     (from Strapi)
//   • airlines      → /airlines/<slug>         (from Strapi, optionally swapped
//                                                for Aviasales affiliate URLs)
//   • articles      → /articles/<slug>         (cross-link between posts;
//                                                excludes the article itself)
//   • external      → https://…                (from a JSON dictionary file)
//
// Strategy per article:
//   1. Protect code fences, inline code, headings, existing markdown links
//      and images.
//   2. Replace the first occurrence of each matched term with [term](url).
//      Longest terms run first so "Bangkok Airways" wins over "Bangkok".
//   3. PUT updated `content` back, capped at --max-links per article.
//
// Idempotent: skips any term whose target URL is already linked in the body.
// Single-word terms require exact-case match so common English words that
// happen to be airline/place names don't link inside lowercase prose.
//
// When no link-type flags are passed, an interactive picker prompts which
// types to enable. Use --yes / --non-interactive to skip the prompt and
// run with the defaults (or whatever --no-X flags were passed).
//
// Usage:
//   node enrich-article-links.js --dry-run                 # preview all
//   node enrich-article-links.js --slug bali-jungle-hotels # one article
//   node enrich-article-links.js --limit 5                 # first 5 only
//   node enrich-article-links.js --no-destinations         # airlines only
//   node enrich-article-links.js --external                # turn on external links
//   node enrich-article-links.js --external-file links.json
//   node enrich-article-links.js -y                        # apply all, no prompt

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false, describe: 'Print proposed links, write nothing' })
  .option('slug', { type: 'string', describe: 'Only process this article slug' })
  .option('category', { alias: 'c', type: 'string', describe: 'Only process articles in this category (slug). Comma-separated for multiple, e.g. "hotels,flights"' })
  .option('limit', { type: 'number', describe: 'Only process the first N articles' })
  .option('max-links', { type: 'number', default: 10, describe: 'Max NEW links to insert per article' })
  .option('min-term-length', { type: 'number', default: 4, describe: 'Skip terms shorter than this' })
  .option('destinations', { type: 'boolean', default: true, describe: 'Link destinations → /destinations/<slug> (use --no-destinations to skip)' })
  .option('airlines', { type: 'boolean', default: true, describe: 'Link airlines → /airlines/<slug> (use --no-airlines to skip)' })
  .option('articles', { type: 'boolean', default: true, describe: 'Link OTHER post titles → /articles/<slug> (use --no-articles to skip). Excludes the current article itself.' })
  .option('external', { type: 'boolean', default: false, describe: 'Link external terms from --external-file (use --external to enable)' })
  .option('external-file', { type: 'string', default: './external-links.json', describe: 'JSON dictionary of external term → URL. Accepts {"term":"url",…} or [{"term":"…","url":"…","subId":"…"}].' })
  .option('tp-airlines', { type: 'boolean', default: false, describe: 'When set, airline mentions become Travelpayouts/Aviasales affiliate links (requires --marker or NEXT_PUBLIC_TP_MARKER env). Airlines without an IATA code keep their internal /airlines/<slug> link.' })
  .option('marker', { type: 'string', describe: 'Travelpayouts affiliate marker. Defaults to NEXT_PUBLIC_TP_MARKER from env.' })
  .option('tp-host', { type: 'string', describe: 'Override Aviasales/white-label host. Defaults to NEXT_PUBLIC_TP_WL_HOST or aviasales.com.' })
  .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'Skip the interactive link-type picker; run with the current flag values.' })
  .option('non-interactive', { type: 'boolean', default: false, describe: 'Same as --yes — skip the interactive prompt.' })
  .option('verbose', { alias: 'v', type: 'boolean', default: false })
  .help()
  .parseSync();

const TP_MARKER = argv.marker || process.env.NEXT_PUBLIC_TP_MARKER || process.env.TRAVELPAYOUTS_MARKER;
const TP_HOST = argv['tp-host'] || process.env.NEXT_PUBLIC_TP_WL_HOST || 'www.aviasales.com';
if (argv['tp-airlines'] && !TP_MARKER) {
  fatal('--tp-airlines requires a marker. Pass --marker <id> or set NEXT_PUBLIC_TP_MARKER in .env.');
}

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

/* ---------- URL builders ---------- */

function airlineUrl(airline) {
  // Internal page by default. With --tp-airlines and a known IATA, route to
  // an Aviasales search filtered by carrier so the click pays out through the
  // affiliate. Airlines without an IATA always fall back to internal.
  if (argv['tp-airlines'] && airline.iataCode && TP_MARKER) {
    const params = new URLSearchParams({
      marker: TP_MARKER,
      sub_id: `article_airline_${airline.slug}`,
      airline: airline.iataCode.toUpperCase(),
    });
    return `https://${TP_HOST}/?${params.toString()}`;
  }
  return `/airlines/${airline.slug}`;
}

/* ---------- External-links loader ---------- */

function loadExternalLinks(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.warn(`  ! external file not found at ${abs} — skipping external links.`);
    return [];
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { fatal(`Failed to parse ${abs}: ${e.message}`); }

  const out = [];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (row && row.term && row.url) out.push({ term: row.term, url: row.url });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [term, url] of Object.entries(raw)) {
      if (typeof url === 'string') out.push({ term, url });
    }
  }
  return out;
}

/* ---------- Term map ---------- */

function buildTerms({ destinations, airlines, articles, externals }) {
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
      if (!a.name || !a.slug) continue;
      add(a.name, airlineUrl(a), 'airline');
    }
  }
  if (argv.articles) {
    // Inter-post linking — match the full article title only. Titles are
    // long, distinctive multi-word phrases so collision risk is low; we
    // never invent a partial-title term.
    for (const ar of articles) {
      if (ar.title && ar.slug) add(ar.title, `/articles/${ar.slug}`, 'article');
    }
  }
  if (argv.external) {
    for (const e of externals) add(e.term, e.url, 'external');
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

async function promptLinkTypes() {
  if (argv.yes || argv['non-interactive']) return;
  if (!process.stdout.isTTY) return; // piped/non-interactive shell — skip

  const choices = [
    { name: 'Destinations  → /destinations/<slug>', value: 'destinations', checked: !!argv.destinations },
    { name: 'Airlines      → /airlines/<slug>',     value: 'airlines',     checked: !!argv.airlines },
    { name: 'Other posts   → /articles/<slug>',     value: 'articles',     checked: !!argv.articles },
    { name: 'External      → URLs from --external-file', value: 'external', checked: !!argv.external },
  ];
  const picked = await checkbox({
    message: 'Which link types should the enricher create?',
    choices,
    instructions: ' (space to toggle, enter to confirm)',
  });
  const set = new Set(picked);
  argv.destinations = set.has('destinations');
  argv.airlines     = set.has('airlines');
  argv.articles     = set.has('articles');
  argv.external     = set.has('external');
}

function printRunSummary({ destinations, airlines, articles, externals }) {
  const row = (on, label, count, target, extra = '') => {
    const mark = on ? '✓' : '✗';
    const c = count == null ? '   —' : String(count).padStart(4);
    console.log(`  ${mark} ${label.padEnd(13)} ${c}   → ${target}${extra}`);
  };
  console.log(`▸ Link types:`);
  row(argv.destinations, 'destinations', destinations.length, '/destinations/<slug>');
  row(
    argv.airlines,
    'airlines',
    airlines.length,
    argv['tp-airlines'] && TP_MARKER ? `https://${TP_HOST}/?marker=${TP_MARKER}&airline=<IATA>` : '/airlines/<slug>',
    argv['tp-airlines'] && TP_MARKER ? '  [affiliate: ON]' : (argv['tp-airlines'] ? '  [affiliate: NO MARKER]' : ''),
  );
  row(argv.articles, 'articles', articles.length, '/articles/<slug>');
  row(
    argv.external,
    'external',
    externals.length,
    `URLs from ${argv['external-file']}`,
  );
  console.log('');
}

async function main() {
  const log = (...args) => console.log(...args);

  await promptLinkTypes();

  log(`▸ Loading data from Strapi …`);
  const [destinations, airlines, allArticles] = await Promise.all([
    argv.destinations ? fetchAll('destinations', ['id', 'name', 'slug']) : [],
    argv.airlines ? fetchAll('airlines', ['id', 'name', 'slug', 'iataCode']) : [],
    argv.articles ? fetchAll('articles', ['id', 'title', 'slug']) : [],
  ]);
  const externals = argv.external ? loadExternalLinks(argv['external-file']) : [];

  printRunSummary({ destinations, airlines, articles: allArticles, externals });

  if (!argv.destinations && !argv.airlines && !argv.articles && !argv.external) {
    fatal('No link types enabled — nothing to do.');
  }

  const categoryFilter = argv.category
    ? argv.category.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const categoryQs = categoryFilter.map((slug, i) => [`filters[category][slug][$in][${i}]`, slug]);

  log(`▸ Loading articles to process${categoryFilter.length ? ` (category: ${categoryFilter.join(', ')})` : ''} …`);
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

  const stats = { processed: 0, modified: 0, totalLinks: 0, errors: 0, byKind: {} };

  for (const a of articles) {
    stats.processed++;
    if (!a.content || typeof a.content !== 'string') {
      log(`  [skip] ${a.slug} — empty content`);
      continue;
    }
    // Build per-article term map so we can exclude the article from
    // linking to itself (inter-post linking).
    const allTerms = buildTerms({ destinations, airlines, articles: allArticles, externals });
    const selfUrl = `/articles/${a.slug}`;
    const terms = allTerms.filter((t) => t.url !== selfUrl);
    const { content: next, inserted } = insertLinks(a.content, terms, argv['max-links']);
    if (inserted.length === 0) {
      if (argv.verbose) log(`  [—] ${a.slug} — no new links`);
      continue;
    }
    stats.modified++;
    stats.totalLinks += inserted.length;
    for (const ins of inserted) {
      stats.byKind[ins.kind] = (stats.byKind[ins.kind] ?? 0) + 1;
    }
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
  for (const [kind, n] of Object.entries(stats.byKind).sort((a, b) => b[1] - a[1])) {
    log(`    · ${kind.padEnd(11)} ${n}`);
  }
  if (stats.errors) log(`  errors:     ${stats.errors}`);
}

function fatal(msg) { console.error('✖', msg); process.exit(1); }

main().catch((e) => fatal(e.stack || e.message));
