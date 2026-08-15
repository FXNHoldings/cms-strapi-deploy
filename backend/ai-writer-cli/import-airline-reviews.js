#!/usr/bin/env node
// FXN AI Writer — Import Airline Reviews (TripAdvisor bulk scrape → Strapi)
//
// Reads an Apify-style "tripadvisor-reviews-bulk" JSON dump — an array of
// { url, data: [review, ...] } blocks, one block per airline — matches each
// block's company token to an existing Strapi `airline`, and creates
// `airline-review` entries for its reviews.
//
// The importer is IDEMPOTENT: every review is written with
// `sourceId = "tripadvisor:<upstream id>"`, which is unique in Strapi, and the
// script pre-loads the sourceIds already stored for each airline and skips
// them. Re-running only imports what is new.
//
// Airlines are NEVER created. A company with no confident match in the Strapi
// airline directory is skipped and listed in `unmatched.csv` so it can be
// mapped by hand via the aliases file and the import re-run:
//
//   aliases.json  { "Cathay_Dragon_Dragonair": "cathay-dragon", ... }
//                 company token -> Strapi airline slug ("" = ignore on purpose)
//
// Run:
//   node import-airline-reviews.js --dry-run          # match + report, no writes
//   node import-airline-reviews.js                    # import everything matched
//   node import-airline-reviews.js --company Thai_AirAsia
//   node import-airline-reviews.js --limit 10         # first 10 airlines only
//   node import-airline-reviews.js --no-aggregates    # skip reviewCount/ratingAvg rollup
//   node import-airline-reviews.js --aggregates-only  # recompute rollups, import nothing
//
// Reports are written to --report-dir (default ./tp-reviews-report):
//   matched.csv    company, airline slug, airline name, how it matched, reviews
//   unmatched.csv  company, reviews, source url          <- feed these to aliases.json
//   ambiguous.csv  company, reviews, candidate slugs     <- resolve via aliases.json
//   errors.csv     sourceId, company, HTTP status, message

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const DEFAULT_FILE =
  '/opt/assets/dataset_tripadvisor-reviews-bulk_2026-07-31_04-11-27-044.json';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('file', { type: 'string', default: DEFAULT_FILE, describe: 'Source JSON dump' })
  .option('source', { type: 'string', default: 'tripadvisor', describe: 'Value stored in the review `source` field and used as the sourceId prefix' })
  .option('aliases', { type: 'string', default: './airline-review-aliases.json', describe: 'company token -> airline slug overrides' })
  .option('report-dir', { type: 'string', default: './tp-reviews-report' })
  .option('company', { type: 'string', describe: 'Import a single company token from the dump' })
  .option('limit', { alias: 'n', type: 'number', default: 0, describe: 'Cap how many airlines are processed (0 = all)' })
  .option('max-reviews', { type: 'number', default: 0, describe: 'Cap reviews imported per airline (0 = all)' })
  .option('concurrency', { type: 'number', default: 4, describe: 'Parallel review writes' })
  .option('aggregates', { type: 'boolean', default: true, describe: 'Roll reviewCount/ratingAvg up onto the airline. Use --no-aggregates to skip.' })
  .option('aggregates-only', { type: 'boolean', default: false, describe: 'Recompute reviewCount/ratingAvg from what is already in Strapi; import nothing' })
  .option('resume', { type: 'boolean', default: true, describe: 'Skip companies already completed per the checkpoint file. Use --no-resume to restart.' })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;

const CHECKPOINT = path.resolve('./.import-airline-reviews.progress.json');
const CABINS = new Set(['Economy', 'Premium Economy', 'Business Class', 'First Class']);

const stats = {
  companies: 0,
  matched: 0,
  unmatched: 0,
  ambiguous: 0,
  created: 0,
  skippedExisting: 0,
  failed: 0,
  airlinesUpdated: 0,
};
const reports = { matched: [], unmatched: [], ambiguous: [], errors: [] };

main().catch((err) => fatal(err.stack || err.message));

async function main() {
  if (!STRAPI_URL) fatal('STRAPI_URL not set (see .env)');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN not set (see .env)');

  const airlines = await fetchAirlines();
  console.log(`Strapi airline directory: ${airlines.length} entries.`);

  if (argv.aggregatesOnly) {
    await recomputeAllAggregates(airlines);
    writeReports();
    summarise();
    return;
  }

  const blocks = readSource(argv.file);
  const index = buildIndex(airlines);
  const aliases = readAliases(argv.aliases);
  const done = argv.resume ? readCheckpoint() : new Set();

  let companies = blocks
    .map(toCompanyBlock)
    .filter((b) => b && b.reviews.length);
  if (argv.company) {
    companies = companies.filter((c) => c.company === argv.company);
    if (!companies.length) fatal(`No company '${argv.company}' in ${argv.file}`);
  }
  stats.companies = companies.length;
  console.log(
    `Source: ${companies.length} companies / ${companies.reduce((n, c) => n + c.reviews.length, 0)} reviews.\n`
  );

  let processed = 0;
  for (const block of companies) {
    if (argv.limit && processed >= argv.limit) break;
    if (done.has(block.company)) continue;

    const match = resolve(block.company, index, aliases);
    if (match.status === 'ignored') continue;
    if (match.status === 'ambiguous') {
      stats.ambiguous++;
      reports.ambiguous.push([block.company, block.reviews.length, match.candidates.join(' | ')]);
      console.log(`?  ${block.company} — ambiguous (${match.candidates.join(', ')})`);
      continue;
    }
    if (match.status === 'unmatched') {
      stats.unmatched++;
      reports.unmatched.push([block.company, block.reviews.length, block.url]);
      console.log(`–  ${block.company} — no airline in Strapi (${block.reviews.length} reviews)`);
      continue;
    }

    stats.matched++;
    processed++;
    reports.matched.push([
      block.company,
      match.airline.slug,
      match.airline.name,
      match.how,
      block.reviews.length,
    ]);
    await importCompany(block, match.airline);
    if (!argv.dryRun) checkpoint(block.company);
  }

  writeReports();
  summarise();
}

/* ---------- source ---------- */

function readSource(file) {
  if (!fs.existsSync(file)) fatal(`Source file not found: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) fatal('Source JSON must be an array of { url, data } blocks');
  return raw;
}

// One dump block -> { company, url, reviews }. The company token only exists on
// the reviews themselves, so it is read from the first row.
function toCompanyBlock(block) {
  const reviews = Array.isArray(block?.data) ? block.data : [];
  const company = reviews.find((r) => r?.company)?.company;
  if (!company) return null;
  return { company, url: block.url || '', reviews };
}

function reviewPayload(review, block, airline) {
  const labels = Array.isArray(review.labels) ? review.labels : [];
  // Upstream labels are [route, tripScope, cabin] but the route and scope are
  // sometimes dropped, so classify rather than index blindly.
  const cabin = labels.find((l) => CABINS.has(l)) || null;
  const rest = labels.filter((l) => l !== cabin);
  const route = rest.find((l) => l.includes(' - ')) || null;
  const tripType = rest.find((l) => l !== route) || null;

  return {
    airline: airline.documentId,
    source: argv.source,
    sourceId: sourceId(review.id),
    // Strapi `string` is varchar(255) in Postgres whatever maxLength claims, so
    // every string field here is clamped to something that fits the column.
    sourceUrl: trim(block.url, 255),
    sourceCompany: block.company,
    rating: clampRating(review.rating),
    title: trim(review.title, 200),
    body: trim(review.text, 10000),
    authorName: trim(review.userDisplay, 120),
    authorLocation: trim(locationOf(review.userLocation), 160),
    authorContributions: intOrNull(review.userCounts?.sumAllUgc),
    authorHelpfulVotes: intOrNull(review.userCounts?.sumAllLikes),
    reviewedAt: dateOrNull(review.publishedAt),
    travelDate: dateOrNull(review.trip?.stayDate),
    route: trim(route, 120),
    tripType: trim(tripType, 60),
    cabinClass: cabin,
    language: trim(review.language, 10) || 'en',
  };
}

const sourceId = (id) => `${argv.source}:${id}`;
const trim = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const intOrNull = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const locationOf = (loc) => loc?.additionalNames?.long || loc?.name || null;

function clampRating(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null;
}

/* ---------- matching ---------- */

function normalise(s) {
  return String(s)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Drop the corporate-form words so "Czech Airlines" and "CSA Czech Airlines"
// can still be told apart by what is left, while "Corsair" matches
// "Corsair International".
function reduce(s) {
  return normalise(s)
    .replace(/\b(airlines|airline|airways|airway|air lines|aviation|company|co|ltd|limited|inc|llc|plc|international|group|holdings)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Company tokens carry editorial suffixes the feed appends to the brand
// ("Germanwings_Merged_Into_Eurowings", "LAN_Airlines_Now_LATAM_Airlines").
// The reviews belong to the brand BEFORE the marker, so everything from the
// marker onwards is dropped rather than followed to the successor.
function stripStatus(company) {
  return company
    .replace(/_?No_Longer_Operating.*$/i, '')
    .replace(/_?Merged_Into.*$/i, '')
    .replace(/_?Now_[A-Z].*$/, '')
    .replace(/_?Formerly_[A-Z].*$/, '')
    .replace(/_?Defunct.*$/i, '')
    .replace(/_+$/, '');
}

// Leading words are only dropped when the token itself says they are
// redundant: a parent brand repeated further along ("AirAsia_Thai_AirAsia"),
// or an acronym of the words that follow ("DAT_Danish_Air_Transport").
// Anything looser reassigns reviews to a different carrier — "Virgin_Atlantic_
// Airways" would otherwise land on Atlantic Airways of the Faroe Islands.
function droppableLead(tokens) {
  if (tokens.length < 2) return false;
  const [lead, ...rest] = tokens;
  const low = lead.toLowerCase();
  if (rest.some((t) => t.toLowerCase() === low)) return true;
  const initials = rest.map((t) => t[0].toLowerCase()).join('');
  return low.length > 1 && initials.startsWith(low);
}

function buildIndex(airlines) {
  const byName = new Map(); // exact normalised name -> [airline]
  const byReduced = new Map(); // corporate-form-stripped name -> [airline]
  const bySlug = new Map();
  for (const a of airlines) {
    if (!a?.slug) continue;
    bySlug.set(a.slug, a);
    push(byName, normalise(a.name), a);
    const r = reduce(a.name);
    if (r) push(byReduced, r, a);
  }
  return { byName, byReduced, bySlug };
}

function push(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function resolve(company, index, aliases) {
  if (Object.prototype.hasOwnProperty.call(aliases, company)) {
    const slug = aliases[company];
    if (!slug) return { status: 'ignored' };
    const a = index.bySlug.get(slug);
    if (!a) fatal(`aliases: '${company}' -> '${slug}' but no airline has that slug`);
    return { status: 'matched', airline: a, how: 'alias' };
  }

  const base = stripStatus(company);
  // Try the full token first, then the same token with redundant leading words
  // peeled off (see droppableLead).
  let tokens = base.split('_').filter(Boolean);
  const variants = [tokens.join(' ')];
  while (droppableLead(tokens)) {
    tokens = tokens.slice(1);
    variants.push(tokens.join(' '));
  }

  for (const [i, v] of variants.entries()) {
    const hit = index.byName.get(normalise(v));
    if (hit?.length === 1) return { status: 'matched', airline: hit[0], how: i === 0 ? 'name' : 'name-suffix' };
    if (hit?.length > 1) return { status: 'ambiguous', candidates: hit.map((a) => a.slug) };
  }

  // Corporate-form-stripped matching runs on the FULL token only. Applied to a
  // prefix-dropped variant it silently swaps brands — "Ravn_Alaska" reduces to
  // "alaska" and would land on Alaska Airlines, a different carrier. Requiring
  // both sides to reduce to the same words keeps this to genuine suffix
  // differences ("Corsair" / "Corsair International", "Vueling Airlines" /
  // "Vueling").
  const hit = index.byReduced.get(reduce(variants[0]));
  // A reduced key that several airlines share (e.g. "cambodia" for both
  // "Air Cambodia" and "Cambodia Airways") is never guessed at.
  if (hit?.length === 1) return { status: 'matched', airline: hit[0], how: 'reduced-name' };
  if (hit?.length > 1) return { status: 'ambiguous', candidates: hit.map((a) => a.slug) };
  return { status: 'unmatched' };
}

function readAliases(file) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log(`Aliases: ${Object.keys(json).length} override(s) from ${p}`);
    return json;
  } catch (err) {
    fatal(`Could not parse aliases file ${p}: ${err.message}`);
  }
}

/* ---------- import ---------- */

async function importCompany(block, airline) {
  const existing = argv.dryRun ? new Set() : await fetchExistingSourceIds(airline);
  let todo = block.reviews.filter((r) => r?.id != null && !existing.has(sourceId(r.id)));
  const already = block.reviews.length - todo.length;
  stats.skippedExisting += already;
  if (argv.maxReviews) todo = todo.slice(0, argv.maxReviews);

  const label = `${block.company} → ${airline.slug}`;
  if (!todo.length) {
    console.log(`=  ${label} — nothing new (${already} already imported)`);
    return;
  }
  if (argv.dryRun) {
    console.log(`+  ${label} — would import ${todo.length} review(s)`);
    return;
  }

  let created = 0;
  await pool(todo, argv.concurrency, async (review) => {
    const payload = reviewPayload(review, block, airline);
    if (!payload.rating || !payload.body) {
      stats.failed++;
      reports.errors.push([payload.sourceId, block.company, 'skipped', 'missing rating or body']);
      return;
    }
    try {
      await strapi('/api/airline-reviews', {
        method: 'POST',
        body: JSON.stringify({ data: payload }),
      });
      created++;
      stats.created++;
    } catch (err) {
      // A unique-constraint rejection means a concurrent/earlier run already
      // stored it — that is a skip, not a failure.
      if (err.status === 400 && /unique/i.test(err.body || '')) {
        stats.skippedExisting++;
        return;
      }
      stats.failed++;
      reports.errors.push([payload.sourceId, block.company, err.status || '-', oneLine(err.message)]);
    }
  });

  console.log(`+  ${label} — ${created} imported, ${already} already there`);
  if (argv.aggregates) await updateAggregates(airline);
}

async function fetchExistingSourceIds(airline) {
  const ids = new Set();
  await eachPage(
    (page) =>
      `/api/airline-reviews?filters[airline][documentId][$eq]=${airline.documentId}` +
      `&filters[source][$eq]=${encodeURIComponent(argv.source)}` +
      `&fields[0]=sourceId&pagination[page]=${page}&pagination[pageSize]=100`,
    (row) => ids.add(row.sourceId)
  );
  return ids;
}

/* ---------- aggregates ---------- */

async function updateAggregates(airline) {
  const ratings = [];
  await eachPage(
    (page) =>
      `/api/airline-reviews?filters[airline][documentId][$eq]=${airline.documentId}` +
      `&fields[0]=rating&pagination[page]=${page}&pagination[pageSize]=100`,
    (row) => Number.isFinite(row.rating) && ratings.push(row.rating)
  );

  const reviewCount = ratings.length;
  const ratingAvg = reviewCount
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / reviewCount) * 10) / 10
    : null;
  if (airline.reviewCount === reviewCount && airline.ratingAvg === ratingAvg) return;

  await strapi(`/api/airlines/${airline.documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { reviewCount, ratingAvg } }),
  });
  airline.reviewCount = reviewCount;
  airline.ratingAvg = ratingAvg;
  stats.airlinesUpdated++;
}

// --aggregates-only: recompute from what Strapi already holds, for every
// airline that has at least one review or a stale non-zero count.
async function recomputeAllAggregates(airlines) {
  const counts = new Map();
  await eachPage(
    (page) => `/api/airline-reviews?fields[0]=rating&populate[airline][fields][0]=documentId` +
      `&pagination[page]=${page}&pagination[pageSize]=100`,
    (row) => {
      const id = row.airline?.documentId;
      if (!id) return;
      if (!counts.has(id)) counts.set(id, []);
      counts.get(id).push(row.rating);
    }
  );

  for (const airline of airlines) {
    const ratings = counts.get(airline.documentId) || [];
    const reviewCount = ratings.length;
    const ratingAvg = reviewCount
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / reviewCount) * 10) / 10
      : null;
    const current = airline.reviewCount ?? 0;
    if (current === reviewCount && (airline.ratingAvg ?? null) === ratingAvg) continue;
    if (argv.dryRun) {
      console.log(`~  ${airline.slug}: ${current}/${airline.ratingAvg ?? '-'} → ${reviewCount}/${ratingAvg ?? '-'}`);
      stats.airlinesUpdated++;
      continue;
    }
    await strapi(`/api/airlines/${airline.documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { reviewCount, ratingAvg } }),
    });
    stats.airlinesUpdated++;
  }
}

/* ---------- Strapi ---------- */

async function strapi(pathname, init = {}, attempt = 1) {
  let res;
  try {
    res = await fetch(`${STRAPI_URL}${pathname}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${STRAPI_API_TOKEN}`,
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    if (attempt < 4) return backoff(pathname, init, attempt);
    throw Object.assign(new Error(`Strapi unreachable on ${pathname}: ${err.message}`), { status: 0 });
  }
  if (res.ok) return res.json();

  const body = await res.text().catch(() => '');
  if ((res.status === 429 || res.status >= 500) && attempt < 4) return backoff(pathname, init, attempt);
  throw Object.assign(new Error(`Strapi ${res.status} on ${pathname}: ${body.slice(0, 300)}`), {
    status: res.status,
    body,
  });
}

async function backoff(pathname, init, attempt) {
  await sleep(500 * 2 ** (attempt - 1));
  return strapi(pathname, init, attempt + 1);
}

async function fetchAirlines() {
  const all = [];
  const url = (page, aggregates) =>
    `/api/airlines?fields[0]=name&fields[1]=slug` +
    (aggregates ? '&fields[2]=reviewCount&fields[3]=ratingAvg' : '') +
    `&sort[0]=name:asc&pagination[page]=${page}&pagination[pageSize]=100`;
  try {
    await eachPage((page) => url(page, true), (row) => all.push(row));
  } catch (err) {
    // The aggregate columns land with the schema change; against a Strapi that
    // has not picked it up yet, still allow a matching dry-run.
    if (err.status !== 400 || !/reviewCount|ratingAvg/.test(err.body || '')) throw err;
    console.warn('!  Strapi has no reviewCount/ratingAvg on airline yet — aggregates disabled.');
    argv.aggregates = false;
    all.length = 0;
    await eachPage((page) => url(page, false), (row) => all.push(row));
  }
  return all;
}

async function eachPage(url, onRow) {
  let page = 1;
  for (;;) {
    const res = await strapi(url(page));
    const rows = res?.data || [];
    rows.forEach(onRow);
    const pageCount = res?.meta?.pagination?.pageCount;
    if (rows.length === 0 || (pageCount && page >= pageCount)) break;
    page++;
  }
}

/* ---------- helpers ---------- */

async function pool(items, size, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, size) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s) => String(s).replace(/\s+/g, ' ').slice(0, 200);

function readCheckpoint() {
  if (!fs.existsSync(CHECKPOINT)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')).companies || []);
  } catch {
    return new Set();
  }
}

function checkpoint(company) {
  const done = readCheckpoint();
  done.add(company);
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ companies: [...done] }, null, 2));
}

function writeReports() {
  const dir = path.resolve(argv.reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'matched.csv': [['company', 'slug', 'name', 'matchedBy', 'reviews'], ...reports.matched],
    'unmatched.csv': [['company', 'reviews', 'sourceUrl'], ...reports.unmatched],
    'ambiguous.csv': [['company', 'reviews', 'candidates'], ...reports.ambiguous],
    'errors.csv': [['sourceId', 'company', 'status', 'message'], ...reports.errors],
  };
  for (const [name, rows] of Object.entries(files)) {
    if (rows.length <= 1 && name !== 'unmatched.csv') continue;
    fs.writeFileSync(path.join(dir, name), rows.map(csvRow).join('\n') + '\n');
  }
  console.log(`\nReports: ${dir}`);
}

function csvRow(cells) {
  return cells
    .map((c) => {
      const s = c == null ? '' : String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

function summarise() {
  console.log(
    `\n${argv.dryRun ? '[dry-run] ' : ''}` +
      `airlines matched ${stats.matched}/${stats.companies} · ` +
      `unmatched ${stats.unmatched} · ambiguous ${stats.ambiguous}\n` +
      `reviews created ${stats.created} · already present ${stats.skippedExisting} · failed ${stats.failed}\n` +
      `airline aggregates updated ${stats.airlinesUpdated}` +
      (argv.dryRun ? '' : `\nCheckpoint: ${CHECKPOINT}`)
  );
  if (stats.failed) process.exitCode = 1;
}

function fatal(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}
