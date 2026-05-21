#!/usr/bin/env node
// FXN — Generate the `about` field on Strapi `routes` records using Claude.
//
// Each route becomes a single tight paragraph (max ~150 words) covering:
//   • the city pair + approximate distance / block time
//   • who the main carriers tend to be
//   • a useful practical note (transfer, terminal, date-line, etc.)
//   • one fare / scheduling pattern
//
// Idempotent: by default skips routes that already have an about field set.
// Use --overwrite to rewrite existing entries.
//
// Usage:
//   node generate-route-about.js --dry-run --limit 3   # preview 3 routes
//   node generate-route-about.js --slug nrt-to-lax     # one specific route
//   node generate-route-about.js --limit 50            # write 50 routes
//   node generate-route-about.js                       # write ALL empty routes
//   node generate-route-about.js --overwrite           # rewrite even non-empty

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: false })
  .option('slug', { type: 'string', describe: 'Only process this route slug' })
  .option('limit', { type: 'number', describe: 'Cap total routes processed in this run' })
  .option('overwrite', { type: 'boolean', default: false, describe: 'Also rewrite routes that already have an about' })
  .option('concurrency', { type: 'number', default: 3 })
  .option('verbose', { alias: 'v', type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN, ANTHROPIC_API_KEY } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
if (!argv['dry-run'] && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set in .env');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

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

async function fetchAllRoutes() {
  const all = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams();
    qs.append('pagination[page]', String(page));
    qs.append('pagination[pageSize]', '100');
    qs.append('fields[0]', 'id');
    qs.append('fields[1]', 'documentId');
    qs.append('fields[2]', 'slug');
    qs.append('fields[3]', 'about');
    qs.append('fields[4]', 'distanceKm');
    qs.append('fields[5]', 'durationMinutes');
    qs.append('populate[origin][fields][0]', 'iata');
    qs.append('populate[origin][fields][1]', 'name');
    qs.append('populate[origin][fields][2]', 'city');
    qs.append('populate[origin][fields][3]', 'country');
    qs.append('populate[destination][fields][0]', 'iata');
    qs.append('populate[destination][fields][1]', 'name');
    qs.append('populate[destination][fields][2]', 'city');
    qs.append('populate[destination][fields][3]', 'country');
    qs.append('populate[carriers][fields][0]', 'name');
    qs.append('populate[carriers][fields][1]', 'iataCode');
    qs.append('sort[0]', 'id:asc');
    const res = await strapi(`/api/routes?${qs.toString()}`);
    all.push(...(res.data || []));
    const total = res.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page++;
  }
  return all;
}

/* ---------- Prompting ---------- */

function buildPrompt(route) {
  const o = route.origin;
  const d = route.destination;
  const dist = route.distanceKm ? `${route.distanceKm.toLocaleString()} km great-circle` : 'unknown distance';
  const dur = route.durationMinutes
    ? `${Math.floor(route.durationMinutes / 60)}h ${route.durationMinutes % 60}m typical block time`
    : 'unknown block time';
  const carriers = (route.carriers ?? [])
    .map((c) => `${c.name}${c.iataCode ? ` (${c.iataCode})` : ''}`)
    .slice(0, 8)
    .join(', ') || 'no carrier data on file';

  return `Write a SINGLE paragraph "about this route" entry for a flight-route directory page.

Route: ${o?.iata} (${o?.city || o?.name}, ${o?.country}) → ${d?.iata} (${d?.city || d?.name}, ${d?.country})
Distance: ${dist}
Duration: ${dur}
Carriers tracked: ${carriers}

Constraints:
- Exactly one paragraph, no line breaks, no markdown, no headings.
- 100-150 words.
- Voice: a knowledgeable travel writer for an editorial blog. Specific, factual, lightly opinionated. No marketing fluff.
- Cover four bases concisely: (1) the route's position in the network and approximate flying time, (2) who the main carriers are and roughly what aircraft serve it (use your general knowledge if no carrier list is supplied), (3) one useful practical note (terminal, transfer time, time-zone or date-line quirk, visa context, ground transit at one end — pick whatever is most useful for this specific city pair), (4) one scheduling/fare pattern (cheapest months, premium-cabin sweet spots, day-of-week patterns).
- Do not invent statistics you don't know. If you're unsure, soften ("typically", "often around"). Do not include prices.
- Do not include the words "About this route" or any heading. Just the paragraph.

Output ONLY the paragraph — nothing else.`;
}

async function generateAbout(route) {
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: buildPrompt(route) }],
  });
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  // Collapse any accidental line breaks (we asked for one paragraph).
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

/* ---------- Concurrency helper ---------- */

async function runPool(items, limit, fn) {
  const results = [];
  const queue = items.slice();
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { results.push(await fn(item)); }
      catch (e) { results.push({ slug: item.slug, error: e.message }); }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------- Main ---------- */

async function main() {
  console.log('▸ Loading routes from Strapi …');
  let routes = await fetchAllRoutes();
  console.log(`  ${routes.length} total routes`);

  if (argv.slug) routes = routes.filter((r) => r.slug === argv.slug);
  if (!argv.overwrite) routes = routes.filter((r) => !r.about || !String(r.about).trim());
  if (argv.limit) routes = routes.slice(0, argv.limit);

  if (!routes.length) {
    console.log('  Nothing to do — every route already has an about (or filter matched nothing).');
    return;
  }

  console.log(`  ${routes.length} route(s) to process ${argv['dry-run'] ? '(DRY RUN)' : ''}`);
  console.log(`  Model: ${CLAUDE_MODEL}   Concurrency: ${argv.concurrency}\n`);

  const stats = { written: 0, dry: 0, errors: 0 };

  await runPool(routes, argv.concurrency, async (route) => {
    const label = `${route.origin?.iata}→${route.destination?.iata}`.padEnd(10);
    const tag = argv['dry-run'] ? '[dry]' : '[ok ]';

    if (argv['dry-run']) {
      // Build the prompt without spending a Claude call — just print the source data.
      const carriers = (route.carriers ?? []).map((c) => c.iataCode || c.name).join(',') || '—';
      console.log(`  ${tag} ${label} dist=${route.distanceKm ?? '?'}km dur=${route.durationMinutes ?? '?'}m carriers=${carriers}`);
      stats.dry++;
      return;
    }

    try {
      const about = await generateAbout(route);
      await strapi(`/api/routes/${route.documentId ?? route.id}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { about } }),
      });
      stats.written++;
      const preview = about.slice(0, 90) + (about.length > 90 ? '…' : '');
      console.log(`  ${tag} ${label} ${about.split(/\s+/).length}w · ${preview}`);
    } catch (e) {
      stats.errors++;
      console.error(`  [err] ${label} ${e.message}`);
    }
  });

  console.log(`\n=== Done ===`);
  if (argv['dry-run']) console.log(`  previewed: ${stats.dry} (no writes, no API spend)`);
  else console.log(`  written:   ${stats.written}`);
  if (stats.errors) console.log(`  errors:    ${stats.errors}`);
}

function fatal(msg) { console.error('✖', msg); process.exit(1); }
main().catch((e) => fatal(e.stack || e.message));
