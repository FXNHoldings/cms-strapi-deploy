#!/usr/bin/env node
// FXN AI Writer — Enrich Airlines (factual fields)
// Backfills legalName / address / phone / website (and gaps in iataCode /
// icaoCode / country / region) on airlines already in Strapi.
//
//   Wikidata first (structured, free)  →  Claude + web_search (fallback)  →  PUT /api/airlines/:id
//
// Run:
//   node enrich-airlines.js                               # all airlines with any empty target field
//   node enrich-airlines.js --iata SQ                     # one airline
//   node enrich-airlines.js --fields website,phone -n 25  # limit which fields & how many
//   node enrich-airlines.js --source wikidata             # skip Claude fallback
//   node enrich-airlines.js --overwrite                   # replace existing values
//   node enrich-airlines.js --dry-run                     # log diffs, no writes
//
// The script is idempotent and resumable — a checkpoint file records the
// last-processed airline slug so interruptions don't restart from zero.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const ALL_FIELDS = ['website', 'phone', 'legalName', 'address', 'country', 'region', 'iataCode', 'icaoCode'];
const DEFAULT_FIELDS = ['website', 'phone', 'legalName', 'address'];

const REGION_BY_COUNTRY = buildRegionMap();

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('fields', {
    type: 'string',
    default: DEFAULT_FIELDS.join(','),
    describe: `Comma-separated fields to enrich. Allowed: ${ALL_FIELDS.join(', ')}`,
  })
  .option('source', {
    type: 'string',
    choices: ['wikidata', 'claude', 'both'],
    default: 'both',
    describe: 'Which enrichment stage(s) to run',
  })
  .option('iata', { type: 'string', describe: 'Target one airline by IATA code' })
  .option('limit', { alias: 'n', type: 'number', default: 0, describe: 'Cap batch size (0 = all)' })
  .option('overwrite', { type: 'boolean', default: false, describe: 'Replace existing values instead of only filling empty ones' })
  .option('concurrency', { type: 'number', default: 3, describe: 'Parallel airlines (keep ≤4 to respect Wikidata rate limits)' })
  .option('resume', { type: 'boolean', default: true, describe: 'Skip airlines already processed per checkpoint file. Use --no-resume to restart.' })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const {
  ANTHROPIC_API_KEY,
  // Factual lookup — Sonnet 4.6 has ~8× the TPM budget of Opus 4.7 and is fine
  // for this JSON-shaped task. Override with ENRICH_CLAUDE_MODEL if you prefer.
  ENRICH_CLAUDE_MODEL = 'claude-sonnet-4-6',
  STRAPI_URL,
  STRAPI_API_TOKEN,
  WIKIDATA_USER_AGENT = 'fxn-enrich-airlines/1.0 (https://originfacts.com)',
} = process.env;
const CLAUDE_MODEL = ENRICH_CLAUDE_MODEL;

const wantFields = argv.fields.split(',').map((s) => s.trim()).filter(Boolean);
for (const f of wantFields) if (!ALL_FIELDS.includes(f)) fatal(`Unknown field "${f}". Allowed: ${ALL_FIELDS.join(', ')}`);
const useClaude = argv.source === 'claude' || argv.source === 'both';
const useWikidata = argv.source === 'wikidata' || argv.source === 'both';

if (useClaude && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY not set (required unless --source wikidata)');
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL not set');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN not set');
}

const claude = useClaude && ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const CHECKPOINT = path.join(process.cwd(), '.enrich-airlines.progress.json');
const checkpoint = loadCheckpoint();

/* ---------- Main ---------- */

await main();

async function main() {
  console.log(`\nEnrich Airlines — fields: ${wantFields.join(', ')} · source: ${argv.source} · ${argv['dry-run'] ? 'DRY RUN' : 'LIVE'}\n`);

  const airlines = await fetchTargetAirlines();
  if (airlines.length === 0) {
    console.log('No airlines need enrichment. Done.\n');
    return;
  }
  console.log(`${airlines.length} airlines to process.\n`);

  let done = 0;
  let failed = 0;
  const queue = [...airlines];

  async function worker(id) {
    while (queue.length > 0) {
      const a = queue.shift();
      if (!a) break;
      const idx = ++done;
      try {
        await enrichOne(a, idx, airlines.length);
        saveCheckpoint(a.slug);
      } catch (e) {
        failed++;
        console.error(`  [${idx}/${airlines.length}] ${a.name} — FAILED: ${e.message}`);
      }
      await sleep(250); // gentle on Wikidata
    }
  }
  await Promise.all(Array.from({ length: argv.concurrency }, (_, i) => worker(i)));

  console.log(`\nDone. ${done - failed} updated, ${failed} failed. Checkpoint: ${CHECKPOINT}\n`);
}

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

async function fetchTargetAirlines() {
  const filters = [];
  if (argv.iata) filters.push(`filters[iataCode][$eqi]=${encodeURIComponent(argv.iata)}`);
  // If --overwrite, we take everything; otherwise only airlines with at least
  // one target field empty. Strapi $null filter with $or would be nicer but
  // its syntax varies across versions — easier to pull all and filter locally.
  const all = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const q = [
      ...filters,
      `pagination[page]=${page}`,
      `pagination[pageSize]=${pageSize}`,
      'sort[0]=name:asc',
    ].join('&');
    const res = await strapi(`/api/airlines?${q}`);
    all.push(...res.data);
    if (res.data.length < pageSize) break;
    page++;
  }
  const eligible = all.filter((a) => {
    if (argv.overwrite) return true;
    return wantFields.some((f) => !a[f] || String(a[f]).trim() === '');
  });
  const toProcess = argv.resume
    ? eligible.filter((a) => !checkpoint.processed.includes(a.slug))
    : eligible;
  return argv.limit > 0 ? toProcess.slice(0, argv.limit) : toProcess;
}

/* ---------- Wikidata ---------- */

async function lookupWikidata({ iataCode, icaoCode }) {
  if (!iataCode && !icaoCode) return {};
  const iata = (iataCode || '').toUpperCase();
  const icao = (icaoCode || '').toUpperCase();
  // P229 = IATA (2-letter), P230 = ICAO (3-letter)
  const clauses = [];
  if (iata) clauses.push(`{ ?a wdt:P229 "${iata}" . }`);
  if (icao) clauses.push(`{ ?a wdt:P230 "${icao}" . }`);
  const query = `
    SELECT ?a ?legalName ?shortName ?website ?phone ?countryLabel ?hqLabel WHERE {
      ${clauses.join(' UNION ')}
      OPTIONAL { ?a rdfs:label ?legalName FILTER (lang(?legalName) = "en") }
      OPTIONAL { ?a wdt:P1813 ?shortName  FILTER (lang(?shortName) = "en") }
      OPTIONAL { ?a wdt:P856  ?website }
      OPTIONAL { ?a wdt:P1329 ?phone }
      OPTIONAL { ?a wdt:P17   ?country . ?country rdfs:label ?countryLabel FILTER (lang(?countryLabel) = "en") }
      OPTIONAL { ?a wdt:P159  ?hq      . ?hq      rdfs:label ?hqLabel      FILTER (lang(?hqLabel) = "en") }
    }
    LIMIT 1
  `;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': WIKIDATA_USER_AGENT } });
  if (!res.ok) throw new Error(`Wikidata ${res.status}`);
  const body = await res.json();
  const row = body.results?.bindings?.[0];
  if (!row) return {};

  const out = {};
  if (row.legalName?.value) out.legalName = row.legalName.value;
  if (row.website?.value) out.website = row.website.value;
  if (row.phone?.value) out.phone = row.phone.value;
  if (row.countryLabel?.value) {
    out.country = row.countryLabel.value;
    const region = REGION_BY_COUNTRY[row.countryLabel.value];
    if (region) out.region = region;
  }
  if (row.hqLabel?.value) out.address = row.hqLabel.value;
  return out;
}

/* ---------- Claude web-search fallback ---------- */

async function lookupClaude(airline, missing) {
  if (!claude || missing.length === 0) return { values: {}, sources: {} };
  const { name, iataCode, icaoCode, country } = airline;
  const system = `You are a research assistant verifying corporate details for airlines.
Use the web_search tool to find information from primary sources: the airline's own site, regulator filings (CAA/FAA/EASA), or Wikipedia with citations.
Return ONLY strict JSON with this shape:
{
  "website":   "https://...",   // official homepage, optional
  "phone":     "+XX ...",        // main corporate phone in E.164-ish format, optional
  "legalName": "...",            // registered legal name, optional
  "address":   "Street, City, Country",  // HQ postal address, optional
  "sources":   { "website": "url", "phone": "url", "legalName": "url", "address": "url" }
}
Omit any field you cannot verify from an official source. Do not guess. Do not wrap the JSON in markdown.`;

  const user = `Airline: ${name}${iataCode ? ` (IATA ${iataCode})` : ''}${icaoCode ? ` (ICAO ${icaoCode})` : ''}${country ? ` — based in ${country}` : ''}
Please find: ${missing.join(', ')}.`;

  const res = await callClaudeWithRetry({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  const json = extractJson(text);
  if (!json) return { values: {}, sources: {} };
  const values = {};
  for (const f of missing) if (json[f]) values[f] = String(json[f]).trim();
  return { values, sources: json.sources || {} };
}

async function callClaudeWithRetry(payload, maxAttempts = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await claude.messages.create(payload);
    } catch (e) {
      lastErr = e;
      // 429 → respect Retry-After, else exponential backoff (6s, 12s, 24s, 48s, capped 60s).
      // 529 (overloaded) → same treatment. Everything else → surface immediately.
      const status = e.status ?? e.response?.status;
      if (status !== 429 && status !== 529) break;
      if (attempt === maxAttempts) break;
      const headerWait = Number(e.headers?.['retry-after'] ?? e.response?.headers?.get?.('retry-after'));
      const waitSec = Number.isFinite(headerWait) && headerWait > 0
        ? Math.min(headerWait, 60)
        : Math.min(6 * 2 ** (attempt - 1), 60);
      console.log(`\n    claude ${status} — waiting ${waitSec}s (attempt ${attempt}/${maxAttempts - 1})`);
      await sleep(waitSec * 1000);
    }
  }
  throw new Error(`Claude: ${lastErr?.message || 'unknown error'}`);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ---------- Merge + validate + write ---------- */

function mergeEnrichment(existing, wikidata, claude) {
  const diff = {};
  for (const field of wantFields) {
    if (!argv.overwrite && existing[field] && String(existing[field]).trim() !== '') continue;
    const val = wikidata[field] ?? claude.values[field];
    if (!val) continue;
    const cleaned = cleanValue(field, val);
    if (!cleaned) continue;
    if (cleaned === existing[field]) continue;
    diff[field] = cleaned;
  }
  return diff;
}

function cleanValue(field, raw) {
  const v = String(raw).trim();
  if (!v) return null;
  if (field === 'website') {
    const url = v.startsWith('http') ? v : `https://${v}`;
    try {
      const u = new URL(url);
      if (!/^[\w.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
      return u.origin + (u.pathname === '/' ? '' : u.pathname);
    } catch {
      return null;
    }
  }
  if (field === 'phone') {
    if (!/^[\d\s+()\-.]{6,}$/.test(v)) return null;
    return v;
  }
  if (field === 'iataCode') return /^[A-Z0-9]{2,3}$/i.test(v) ? v.toUpperCase() : null;
  if (field === 'icaoCode') return /^[A-Z]{3}$/i.test(v) ? v.toUpperCase() : null;
  if (v.length > 500) return v.slice(0, 500);
  return v;
}

async function writeBack(airline, diff) {
  if (Object.keys(diff).length === 0) return;
  if (argv['dry-run']) return;
  await strapi(`/api/airlines/${airline.documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: diff }),
  });
}

/* ---------- Per-airline flow ---------- */

async function enrichOne(airline, idx, total) {
  const short = (airline.name || '').padEnd(32).slice(0, 32);
  const iata = airline.iataCode ? `(${airline.iataCode})` : '      ';
  process.stdout.write(`[${String(idx).padStart(3)}/${total}] ${short} ${iata}  `);

  const missingInitial = wantFields.filter((f) => !airline[f] || String(airline[f]).trim() === '');
  if (!argv.overwrite && missingInitial.length === 0) {
    console.log('— all target fields filled, skip');
    return;
  }

  let wiki = {};
  if (useWikidata) {
    try {
      wiki = await lookupWikidata(airline);
    } catch (e) {
      console.log(`\n    wikidata error: ${e.message}`);
    }
  }
  const filledByWiki = Object.keys(wiki).filter((k) => wantFields.includes(k) && wiki[k]);

  let claudeResult = { values: {}, sources: {} };
  const stillMissing = missingInitial.filter((f) => !wiki[f]);
  if (useClaude && stillMissing.length > 0) {
    try {
      claudeResult = await lookupClaude(airline, stillMissing);
    } catch (e) {
      console.log(`\n    claude error: ${e.message}`);
    }
  }
  const filledByClaude = Object.keys(claudeResult.values);

  const diff = mergeEnrichment(airline, wiki, claudeResult);
  const changed = Object.keys(diff);

  const parts = [];
  if (filledByWiki.length) parts.push(`wiki: +${filledByWiki.join(' +')}`);
  if (filledByClaude.length) parts.push(`claude: +${filledByClaude.join(' +')}`);
  if (changed.length === 0) parts.push('no new data');
  console.log(parts.join(' · '));

  if (changed.length && filledByClaude.length && Object.keys(claudeResult.sources).length) {
    for (const f of filledByClaude) {
      if (claudeResult.sources[f]) console.log(`    ${f} ← ${claudeResult.sources[f]}`);
    }
  }

  if (changed.length) {
    if (argv['dry-run']) {
      console.log(`    DRY RUN would PUT: ${JSON.stringify(diff)}`);
    } else {
      await writeBack(airline, diff);
    }
  }
}

/* ---------- Checkpoint ---------- */

function loadCheckpoint() {
  try {
    const raw = fs.readFileSync(CHECKPOINT, 'utf8');
    const j = JSON.parse(raw);
    return { processed: Array.isArray(j.processed) ? j.processed : [] };
  } catch {
    return { processed: [] };
  }
}

function saveCheckpoint(slug) {
  checkpoint.processed.push(slug);
  try {
    fs.writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
  } catch {
    // checkpoint is best-effort
  }
}

/* ---------- Country → region map (mirror of ingest-travelpayouts.js) ---------- */

function buildRegionMap() {
  const map = {};
  const add = (region, names) => names.forEach((n) => (map[n] = region));
  add('Oceania', ['Australia', 'New Zealand', 'Fiji', 'Papua New Guinea', 'Samoa', 'Tonga', 'Vanuatu']);
  add('Asia-Pacific', [
    'Japan', 'China', "People's Republic of China", 'South Korea', 'Korea', 'Taiwan', 'Hong Kong', 'Macau',
    'Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines', 'Cambodia', 'Laos',
    'Myanmar', 'Brunei', 'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Bhutan', 'Mongolia',
    'Maldives',
  ]);
  add('Europe', [
    'United Kingdom', 'Ireland', 'France', 'Germany', 'Spain', 'Portugal', 'Italy', 'Netherlands',
    'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Denmark', 'Sweden', 'Norway', 'Finland',
    'Iceland', 'Poland', 'Czech Republic', 'Czechia', 'Slovakia', 'Hungary', 'Romania', 'Bulgaria',
    'Greece', 'Cyprus', 'Malta', 'Croatia', 'Slovenia', 'Serbia', 'Bosnia and Herzegovina', 'Montenegro',
    'North Macedonia', 'Albania', 'Estonia', 'Latvia', 'Lithuania', 'Ukraine', 'Belarus', 'Russia',
    'Moldova', 'Turkey',
  ]);
  add('Americas', [
    'United States', 'United States of America', 'USA', 'Canada', 'Mexico', 'Guatemala', 'Belize',
    'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Cuba', 'Dominican Republic',
    'Haiti', 'Jamaica', 'Puerto Rico', 'Bahamas', 'Barbados', 'Trinidad and Tobago', 'Brazil', 'Argentina',
    'Chile', 'Uruguay', 'Paraguay', 'Bolivia', 'Peru', 'Ecuador', 'Colombia', 'Venezuela', 'Guyana',
    'Suriname',
  ]);
  add('Middle East', [
    'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman', 'Yemen', 'Iraq',
    'Iran', 'Israel', 'Jordan', 'Lebanon', 'Syria',
  ]);
  add('Africa', [
    'South Africa', 'Egypt', 'Morocco', 'Tunisia', 'Algeria', 'Libya', 'Nigeria', 'Kenya', 'Ethiopia',
    'Tanzania', 'Uganda', 'Rwanda', 'Ghana', 'Senegal', "Côte d'Ivoire", 'Ivory Coast', 'Cameroon',
    'Mozambique', 'Zambia', 'Zimbabwe', 'Botswana', 'Namibia', 'Angola', 'Madagascar', 'Mauritius',
    'Seychelles',
  ]);
  return map;
}

/* ---------- Utils ---------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fatal(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}
