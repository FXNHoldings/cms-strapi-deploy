#!/usr/bin/env node
// FXN AI Writer — Enrich Airlines (factual fields + About content)
// Backfills legalName / address / phone / website (and gaps in iataCode /
// icaoCode / country / region) AND generates the `about` prose +
// `keyDestinations` for airlines already in Strapi.
//
//   Factual fields: Wikidata first (structured, free) → Claude fallback
//   About + keyDestinations: Claude (grounded in the record's own fields)
//   → PUT /api/airlines/:id
//
// The `about` step runs AFTER the factual step in the same pass, so the prose
// is grounded in freshly-corrected facts. It is capped at 4 paragraphs and
// only lists real destinations Claude is confident about (empty otherwise).
//
// Run:
//   node enrich-airlines.js                               # fill empty factual fields + empty about
//   node enrich-airlines.js --iata SQ                     # one airline
//   node enrich-airlines.js --fields website,phone -n 25  # limit which factual fields & how many
//   node enrich-airlines.js --fields about                # ONLY (re)generate the about + destinations
//   node enrich-airlines.js --source wikidata             # skip Claude for facts (about still needs Claude)
//   node enrich-airlines.js --no-about                    # factual fields only, skip about
//   node enrich-airlines.js --overwrite                   # replace existing values (incl. rewrite about)
//   node enrich-airlines.js --dry-run                     # log diffs / print about, no writes
//
// The script is idempotent and resumable — a checkpoint file records the
// last-processed airline slug so interruptions don't restart from zero.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// `about` is a synthesised field (Claude prose + keyDestinations), handled by
// a separate stage from the factual/Wikidata fields below.
const FACTUAL_FIELDS = ['website', 'phone', 'legalName', 'address', 'country', 'region', 'iataCode', 'icaoCode'];
const ALL_FIELDS = [...FACTUAL_FIELDS, 'about'];
const DEFAULT_FIELDS = ['website', 'phone', 'legalName', 'address', 'icaoCode', 'country', 'region', 'about'];

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
  .option('overwrite', { type: 'boolean', default: false, describe: 'Replace existing values instead of only filling empty ones (incl. rewriting about)' })
  .option('about', { type: 'boolean', default: true, describe: 'Generate the about prose + keyDestinations. Use --no-about to skip.' })
  .option('min-words', { type: 'number', default: 180, describe: 'Reject about drafts shorter than this' })
  .option('min-paragraphs', { type: 'number', default: 5, describe: 'Skip about generation when the existing about already has this many paragraphs (ignored with --overwrite)' })
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

const requestedFields = argv.fields.split(',').map((s) => s.trim()).filter(Boolean);
for (const f of requestedFields) if (!ALL_FIELDS.includes(f)) fatal(`Unknown field "${f}". Allowed: ${ALL_FIELDS.join(', ')}`);
// Factual fields feed the Wikidata/Claude-facts stage; `about` is its own stage.
const wantFields = requestedFields.filter((f) => f !== 'about');
const wantAbout = argv.about && requestedFields.includes('about');
const useClaude = argv.source === 'claude' || argv.source === 'both';
const useWikidata = argv.source === 'wikidata' || argv.source === 'both';

// About generation always needs Claude regardless of --source.
if ((useClaude || wantAbout) && !ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY not set (required for Claude facts and about generation)');
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL not set');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN not set');
}

const claude = (useClaude || wantAbout) && ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const CHECKPOINT = path.join(process.cwd(), '.enrich-airlines.progress.json');
const checkpoint = loadCheckpoint();

/* ---------- Main ---------- */

await main();

async function main() {
  const stages = [wantFields.length ? `facts(${wantFields.join(',')})` : null, wantAbout ? 'about' : null].filter(Boolean).join(' + ');
  console.log(`\nEnrich Airlines — ${stages || 'nothing selected'} · source: ${argv.source} · ${argv['dry-run'] ? 'DRY RUN' : 'LIVE'}${argv.overwrite ? ' · OVERWRITE' : ''}\n`);

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
    const needsFactual = wantFields.some((f) => !a[f] || String(a[f]).trim() === '');
    const needsAbout = wantAbout && aboutNeedsWork(a.about);
    return needsFactual || needsAbout;
  });
  const toProcess = argv.resume
    ? eligible.filter((a) => !checkpoint.processed.includes(a.slug))
    : eligible;
  return argv.limit > 0 ? toProcess.slice(0, argv.limit) : toProcess;
}

/* ---------- About generation (Claude prose + keyDestinations) ---------- */

// True when the about is empty or thinner than --min-paragraphs (and not
// protected by an existing substantial about, unless --overwrite).
function aboutNeedsWork(about) {
  const t = String(about || '').trim();
  if (!t) return true;
  return countParagraphs(t) < argv['min-paragraphs'];
}

function countParagraphs(text) {
  const t = String(text).replace(/\r\n/g, '\n').trim();
  if (!t) return 0;
  const byBlank = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank.length;
  return t.split(/\n/).map((l) => l.trim()).filter(Boolean).length;
}

function systemPromptAbout() {
  return `You are a senior aviation editor writing an airline directory entry for a travel blog.
Return STRICT JSON: { "shortDescription": string, "aboutParagraphs": string[], "keyDestinations": string[], "frequentFlyerProgram": string, "frequentFlyerUrl": string, "goodToKnow": [{ "title": string, "body": string }], "faqs": [{ "q": string, "a": string }] }

"shortDescription": a concise tagline shown directly under the airline's name — MAXIMUM 2 sentences (aim for 1-2), no more than ~35 words. State what the airline is: its type, home country, and one defining trait (e.g. "Australia's second-largest carrier, offering full-service domestic and short-haul international flights from its Brisbane hub."). Plain text, no markdown, no newlines.

"aboutParagraphs": an array of EXACTLY 5 strings, each string being ONE paragraph of neutral, factual prose. Combined length 300-420 words. Across the five paragraphs cover, where applicable: (1) founding year, ownership and identity; (2) primary hub and the main routes/regions served; (3) fleet family (e.g. Airbus A350, Boeing 787) and cabin/service classes; (4) alliance membership (Star Alliance / SkyTeam / Oneworld) and the frequent-flyer programme; (5) one honest note — a genuine strength or a fair challenge. Plain prose only — no markdown, no bullet lists, no headings, no promotional language, no newline characters inside any paragraph string. Return EXACTLY 5 items.

"keyDestinations": an array of up to 12 real, notable cities the airline actually flies to (city name only). MUST reflect genuine destinations you are confident about. If NOT confident (small, obscure, defunct, or unknown network), return [] rather than guessing. Never invent destinations.

"frequentFlyerProgram": the exact name of the airline's loyalty / frequent-flyer programme (e.g. "Velocity Frequent Flyer", "KrisFlyer", "Miles & More"). Return an EMPTY string "" if the airline has no such programme or you are not sure of its name.

"frequentFlyerUrl": the official homepage URL of that frequent-flyer programme (e.g. "https://www.velocityfrequentflyer.com", "https://www.singaporeair.com/en_UK/us/ppsclub-krisflyer/"). Return an EMPTY string "" if you are not confident of the exact official URL. Never guess a URL — an empty string is better than a wrong link.

"goodToKnow": an array of AT LEAST 4 (up to 6) objects, each { "title": short heading (2-5 words), "body": 1-2 sentence practical tip }. These are traveller-useful "good to know" notes for flying this airline — e.g. baggage policy quirks, seat/cabin comfort, check-in/boarding, loyalty perks, on-board service, punctuality reputation, hub connections. Ground them in what is true for THIS airline and its type; give general-but-accurate guidance rather than inventing specifics. Always return at least 4 items. No markdown, no newlines inside strings.

"faqs": an array of EXACTLY 8 objects, each { "q": question, "a": answer }. Use THESE 8 questions verbatim, substituting the airline name (keep this order in the array; the site will shuffle them):
  1. "What is <NAME>'s primary hub?"
  2. "Where does <NAME> fly to?"
  3. "How many destinations does <NAME> fly to?"
  4. "What are the most popular airports for <NAME> flights to depart from?"
  5. "What is <NAME>'s carry-on size allowance?"
  6. "When are <NAME> plane tickets cheapest?"
  7. "What is the longest <NAME> route?"
  8. "How does Originfacts find low prices on <NAME> flights?"
Each answer: 1-3 sentences, factual and specific to this airline where possible, otherwise sensible general guidance. For Q8 always explain that Originfacts compares live fares from hundreds of airlines and travel agencies via its partner Travelpayouts and never adds a fee. Do not fabricate exact figures (carry-on dimensions, precise route distances) — speak generally if unsure. No markdown, no newlines inside answers.

Ground every claim in the airline identified by the user's data. If unsure of a specific fact, speak generally rather than inventing specifics. Do not fabricate awards, statistics, dates, or destinations. Output only the JSON object — no text outside it, no markdown fences.`;
}

function userPromptAbout(a) {
  return [
    `Airline: ${a.name}`,
    a.iataCode ? `IATA: ${a.iataCode}` : '',
    a.icaoCode ? `ICAO: ${a.icaoCode}` : '',
    a.legalName ? `Legal name: ${a.legalName}` : '',
    a.type ? `Type: ${a.type}` : '',
    a.country ? `Country (HQ): ${a.country}` : '',
    a.city ? `Hub city: ${a.city}` : '',
    a.airport ? `Main hub airport: ${a.airport}` : '',
    a.founded ? `Founded: ${a.founded}` : '',
    a.website ? `Website: ${a.website}` : '',
    '',
    'Write the "about" prose for this airline.',
  ].filter(Boolean).join('\n');
}

// Returns { about, keyDestinations } or null when the draft is unusable.
// `merged` is the airline record with any freshly-enriched factual fields
// already applied, so the prose reflects corrected facts.
async function generateAbout(merged) {
  if (!claude) return null;
  const msg = await claude.messages.create({
    model: CLAUDE_MODEL,
    // Generous ceiling: adaptive thinking + the full JSON (5 paragraphs,
    // destinations, FFP + URL, 4-6 good-to-know cards, 8 FAQ Q&As) is large.
    max_tokens: 10000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: systemPromptAbout(),
    messages: [{ role: 'user', content: userPromptAbout(merged) }],
  });
  if (msg.stop_reason === 'max_tokens') {
    console.log('\n    about warning: response hit max_tokens (may be incomplete)');
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  // Paragraphs come as an array (avoids invalid raw newlines inside a JSON
  // string); fall back to a legacy single `about` string if present.
  let paras = [];
  if (json && Array.isArray(json.aboutParagraphs)) {
    paras = json.aboutParagraphs.map((p) => String(p).trim()).filter(Boolean);
  } else if (json && typeof json.about === 'string') {
    paras = json.about.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }
  paras = paras.slice(0, 5);
  const about = paras.join('\n\n');
  if (!about) return null;
  // Short description — clamp to at most 2 sentences. Dots inside common
  // abbreviations (U.S., U.K., St., etc.) are temporarily swapped to a
  // sentinel so they are not treated as sentence boundaries, then restored.
  let shortDescription = json && typeof json.shortDescription === 'string' ? json.shortDescription.trim() : '';
  if (shortDescription) {
    const SENT = '@@DOT@@';
    const ABBR = /\b(U\.S\.A|U\.S|U\.K|U\.A\.E|St|Mt|Mr|Ms|Mrs|Dr|Inc|Ltd|Co|vs|etc|e\.g|i\.e)\./gi;
    const masked = shortDescription.replace(ABBR, (m) => m.replace(/\./g, SENT));
    const sentences = masked.match(/[^.!?]+[.!?]+/g);
    const kept = sentences && sentences.length > 2 ? sentences.slice(0, 2).join(' ') : masked;
    shortDescription = kept.split(SENT).join('.').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  const words = about.split(/\s+/).filter(Boolean).length;
  if (words < argv['min-words']) return null;
  const keyDestinations = Array.isArray(json.keyDestinations)
    ? json.keyDestinations.map((d) => String(d).trim()).filter((d) => d && d.length <= 60).slice(0, 12)
    : [];
  const frequentFlyerProgram =
    json && typeof json.frequentFlyerProgram === 'string' ? json.frequentFlyerProgram.trim().slice(0, 120) : '';
  let frequentFlyerUrl = json && typeof json.frequentFlyerUrl === 'string' ? json.frequentFlyerUrl.trim() : '';
  if (frequentFlyerUrl && !/^https?:\/\/[^\s]+\.[a-z]{2,}/i.test(frequentFlyerUrl)) frequentFlyerUrl = '';
  const faqs = Array.isArray(json.faqs)
    ? json.faqs
        .map((f) => ({ q: String(f?.q || '').trim(), a: String(f?.a || '').trim() }))
        .filter((f) => f.q && f.a)
        .slice(0, 8)
    : [];
  const goodToKnow = Array.isArray(json.goodToKnow)
    ? json.goodToKnow
        .map((c) => ({ title: String(c?.title || '').trim(), body: String(c?.body || '').trim() }))
        .filter((c) => c.title && c.body)
        .slice(0, 6)
    : [];
  return { about, shortDescription, keyDestinations, frequentFlyerProgram, frequentFlyerUrl, faqs, goodToKnow, words };
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
    SELECT ?a ?legalName ?shortName ?website ?phone ?countryLabel ?hqLabel ?iataOut ?icaoOut WHERE {
      ${clauses.join(' UNION ')}
      OPTIONAL { ?a rdfs:label ?legalName FILTER (lang(?legalName) = "en") }
      OPTIONAL { ?a wdt:P1813 ?shortName  FILTER (lang(?shortName) = "en") }
      OPTIONAL { ?a wdt:P856  ?website }
      OPTIONAL { ?a wdt:P1329 ?phone }
      OPTIONAL { ?a wdt:P229  ?iataOut }
      OPTIONAL { ?a wdt:P230  ?icaoOut }
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
  if (row.iataOut?.value) out.iataCode = row.iataOut.value;
  if (row.icaoOut?.value) out.icaoCode = row.icaoOut.value;
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
  "address":   "Street, City, Postcode, Country",  // FULL HQ postal address, optional
  "iataCode":  "XX",             // 2-char IATA code, optional
  "icaoCode":  "XXX",            // 3-char ICAO code, optional
  "country":   "...",            // country of headquarters, optional
  "sources":   { "website": "url", "phone": "url", "legalName": "url", "address": "url", "iataCode": "url", "icaoCode": "url", "country": "url" }
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
  const needsAbout = wantAbout && (argv.overwrite || aboutNeedsWork(airline.about));
  if (!argv.overwrite && missingInitial.length === 0 && !needsAbout) {
    console.log('— all target fields filled, skip');
    return;
  }

  // --- Stage 1: factual fields (Wikidata → Claude) ---
  let wiki = {};
  if (useWikidata && (argv.overwrite || missingInitial.length > 0)) {
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

  // --- Stage 2: about + keyDestinations, grounded in the corrected facts ---
  let aboutInfo = null;
  if (needsAbout) {
    const merged = { ...airline, ...diff }; // prose sees freshly-enriched facts
    try {
      aboutInfo = await generateAbout(merged);
      if (aboutInfo) {
        diff.about = aboutInfo.about;
        diff.keyDestinations = aboutInfo.keyDestinations;
        if (aboutInfo.faqs.length) diff.faqs = aboutInfo.faqs;
        if (aboutInfo.goodToKnow.length) diff.goodToKnow = aboutInfo.goodToKnow;
        if (aboutInfo.frequentFlyerProgram) diff.frequentFlyerProgram = aboutInfo.frequentFlyerProgram;
        if (aboutInfo.frequentFlyerUrl) diff.frequentFlyerUrl = aboutInfo.frequentFlyerUrl;
        if (aboutInfo.shortDescription) diff.shortDescription = aboutInfo.shortDescription;
      }
    } catch (e) {
      console.log(`\n    about error: ${e.message}`);
    }
  }

  const changed = Object.keys(diff);

  const parts = [];
  if (filledByWiki.length) parts.push(`wiki: +${filledByWiki.join(' +')}`);
  if (filledByClaude.length) parts.push(`claude: +${filledByClaude.join(' +')}`);
  if (aboutInfo) parts.push(`about: ${aboutInfo.words}w · ${aboutInfo.keyDestinations.length} dests · ${aboutInfo.goodToKnow.length} gtk · ${aboutInfo.faqs.length} faqs${aboutInfo.frequentFlyerProgram ? ` · FFP:${aboutInfo.frequentFlyerProgram}${aboutInfo.frequentFlyerUrl ? '↗' : ''}` : ''}`);
  if (changed.length === 0) parts.push('no new data');
  console.log(parts.join(' · '));

  if (changed.length && filledByClaude.length && Object.keys(claudeResult.sources).length) {
    for (const f of filledByClaude) {
      if (claudeResult.sources[f]) console.log(`    ${f} ← ${claudeResult.sources[f]}`);
    }
  }

  if (changed.length) {
    if (argv['dry-run']) {
      const preview = { ...diff };
      if (preview.about) preview.about = `${preview.about.slice(0, 60)}… (${aboutInfo?.words}w, ${aboutInfo?.about.split(/\n\n/).length}p)`;
      if (preview.faqs) preview.faqs = `[${preview.faqs.length} Q&A]`;
      console.log(`    DRY RUN would PUT: ${JSON.stringify(preview)}`);
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
  // Asia = former Asia-Pacific + Middle East
  add('Asia', [
    'Japan', 'China', "People's Republic of China", 'South Korea', 'Korea', 'Taiwan', 'Hong Kong', 'Macau',
    'Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines', 'Cambodia', 'Laos',
    'Myanmar', 'Brunei', 'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Bhutan', 'Mongolia',
    'Maldives',
    'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman', 'Yemen', 'Iraq',
    'Iran', 'Israel', 'Jordan', 'Lebanon', 'Syria',
  ]);
  add('Europe', [
    'United Kingdom', 'Ireland', 'France', 'Germany', 'Spain', 'Portugal', 'Italy', 'Netherlands',
    'Belgium', 'Luxembourg', 'Switzerland', 'Austria', 'Denmark', 'Sweden', 'Norway', 'Finland',
    'Iceland', 'Poland', 'Czech Republic', 'Czechia', 'Slovakia', 'Hungary', 'Romania', 'Bulgaria',
    'Greece', 'Cyprus', 'Malta', 'Croatia', 'Slovenia', 'Serbia', 'Bosnia and Herzegovina', 'Montenegro',
    'North Macedonia', 'Albania', 'Estonia', 'Latvia', 'Lithuania', 'Ukraine', 'Belarus', 'Russia',
    'Moldova', 'Turkey',
  ]);
  // Americas split: Northern + Central + Caribbean → North America; everything else → South America.
  add('North America', [
    'United States', 'United States of America', 'USA', 'Canada', 'Mexico', 'Guatemala', 'Belize',
    'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Cuba', 'Dominican Republic',
    'Haiti', 'Jamaica', 'Puerto Rico', 'Bahamas', 'Barbados', 'Trinidad and Tobago',
  ]);
  add('South America', [
    'Brazil', 'Argentina', 'Chile', 'Uruguay', 'Paraguay', 'Bolivia', 'Peru', 'Ecuador', 'Colombia',
    'Venezuela', 'Guyana', 'Suriname',
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

// Lenient JSON parse — tolerates prose/markdown around the object.
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
