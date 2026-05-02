#!/usr/bin/env node
// FXN — Fill empty `country` on airlines using OpenFlights airlines.dat.
//
// OpenFlights' MIT-licensed CSV (~6,000 airlines worldwide) is structured,
// fast, deterministic, and free — a much better first pass than calling
// Claude with web_search.
//
// Lookup order per airline:
//   1. Exact name match (case-insensitive) — most discriminating
//   2. IATA / ICAO match, BUT only if the OpenFlights name is similar to ours
//      (rejects defunct-airline collisions where IATA codes were reused)
//
// Without the name guard, IATA-first matching produces wildly wrong countries
// (Bangkok Airways → ✓; Norse Atlantic Airways "N0" → defunct Russian carrier
// in the same IATA slot → "Argentina" ✗).
//
// Idempotent: by default only fills airlines whose `country` is NULL/empty.
// Re-runs cost nothing.
//
// Usage:
//   node enrich-airline-country.js --dry-run     # preview
//   node enrich-airline-country.js               # apply
//   node enrich-airline-country.js --refresh     # re-download airlines.dat
//   node enrich-airline-country.js --overwrite   # also rewrite non-null country values

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('concurrency', { type: 'number', default: 6 })
  .option('refresh', { type: 'boolean', default: false })
  .option('overwrite', { type: 'boolean', default: false, describe: 'Also overwrite existing country values' })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');

const OPENFLIGHTS_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
const CACHE_DIR = path.join(os.tmpdir(), 'fxn-openflights-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_FILE = path.join(CACHE_DIR, 'airlines.dat');

/* ---------- Helpers ---------- */

function fatal(msg) { console.error('✖', msg); process.exit(1); }

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
    throw new Error(`Strapi ${res.status} on ${pathname}: ${body.slice(0, 240)}`);
  }
  return res.json();
}

async function runConcurrent(items, worker, concurrency) {
  let idx = 0;
  const stats = { matched: 0, skipped: 0, failed: 0, unmatched: 0 };
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        const r = await worker(items[i]);
        if (r === 'matched') stats.matched++;
        else if (r === 'unmatched') stats.unmatched++;
        else stats.skipped++;
      } catch (e) {
        stats.failed++;
        console.error(`    ✖ ${items[i]?.name ?? items[i]?.id}: ${e.message.slice(0, 140)}`);
      }
    }
  });
  await Promise.all(workers);
  return stats;
}

/* ---------- OpenFlights loader & parser ---------- */

async function loadOpenFlights() {
  if (!argv.refresh && fs.existsSync(CACHE_FILE)) {
    const ageMin = Math.round((Date.now() - fs.statSync(CACHE_FILE).mtimeMs) / 60000);
    console.log(`  [cache] airlines.dat (${ageMin} min old)`);
    return fs.readFileSync(CACHE_FILE, 'utf8');
  }
  process.stdout.write('  [download] OpenFlights airlines.dat … ');
  const res = await fetch(OPENFLIGHTS_URL);
  if (!res.ok) throw new Error(`OpenFlights ${res.status}`);
  const body = await res.text();
  fs.writeFileSync(CACHE_FILE, body);
  console.log(`${(body.length / 1024).toFixed(1)} KB`);
  return body;
}

// airlines.dat is a quoted CSV with NO header.
// Columns: ID,Name,Alias,IATA,ICAO,Callsign,Country,Active
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { out.push(cur); cur = ''; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

function buildIndex(text) {
  const byIata = new Map();
  const byIcao = new Map();
  const byName = new Map();
  const byNormalizedName = new Map();
  let kept = 0;
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    total++;
    const cols = parseCsvLine(line);
    if (cols.length < 8) continue;
    const [, name, , iata, icao, , country, active] = cols;
    if (!country || country === '\\N' || country === '-') continue;

    const entry = { name, iata, icao, country, active };
    kept++;

    // Prefer ACTIVE airlines so defunct ones don't shadow current carriers.
    if (iata && iata !== '-' && iata !== '\\N' && iata.length === 2) {
      const key = iata.toUpperCase();
      if (!byIata.has(key) || (active === 'Y' && byIata.get(key).active !== 'Y')) {
        byIata.set(key, entry);
      }
    }
    if (icao && icao !== '-' && icao !== '\\N' && icao.length === 3) {
      const key = icao.toUpperCase();
      if (!byIcao.has(key) || (active === 'Y' && byIcao.get(key).active !== 'Y')) {
        byIcao.set(key, entry);
      }
    }
    if (name) {
      const key = name.trim().toLowerCase();
      if (!byName.has(key) || (active === 'Y' && byName.get(key).active !== 'Y')) {
        byName.set(key, entry);
      }
      const nkey = normalizeName(name);
      if (nkey && (!byNormalizedName.has(nkey) || (active === 'Y' && byNormalizedName.get(nkey).active !== 'Y'))) {
        byNormalizedName.set(nkey, entry);
      }
    }
  }
  console.log(`  parsed ${kept}/${total} OpenFlights rows (with country)`);
  console.log(`  index sizes: iata=${byIata.size}, icao=${byIcao.size}, name=${byName.size}, norm-name=${byNormalizedName.size}`);
  return { byIata, byIcao, byName, byNormalizedName };
}

function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\b(airlines?|airways|aviation|air lines|company|co\.?|inc\.?|ltd\.?|llc|corp\.?|corporation|holdings?|group|s\.a\.?|gmbh|pty)\b/g, '')
    .replace(/[^\w]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reject IATA/ICAO matches whose name is wildly different from ours.
// Tokens-overlap heuristic: at least one shared "meaningful" word.
function nameRoughlyMatches(a, b) {
  const ta = new Set(normalizeName(a).split(' ').filter((w) => w.length >= 3));
  const tb = new Set(normalizeName(b).split(' ').filter((w) => w.length >= 3));
  if (ta.size === 0 || tb.size === 0) return false;
  for (const w of ta) if (tb.has(w)) return true;
  return false;
}

function lookupAirline(airline, idx) {
  // 1. Exact name match (case-insensitive) — highest confidence.
  if (airline.name) {
    const hit = idx.byName.get(airline.name.trim().toLowerCase());
    if (hit) return { hit, via: 'name' };
  }
  // 2. IATA — but require the name to roughly agree.
  if (airline.iataCode) {
    const hit = idx.byIata.get(airline.iataCode.toUpperCase());
    if (hit && nameRoughlyMatches(airline.name, hit.name)) return { hit, via: 'iata+name' };
  }
  // 3. ICAO — same name guard.
  if (airline.icaoCode) {
    const hit = idx.byIcao.get(airline.icaoCode.toUpperCase());
    if (hit && nameRoughlyMatches(airline.name, hit.name)) return { hit, via: 'icao+name' };
  }
  // 4. Normalized-name match (strip "Airlines"/"Airways" etc.) — last attempt.
  if (airline.name) {
    const norm = normalizeName(airline.name);
    if (norm) {
      const hit = idx.byNormalizedName?.get(norm);
      if (hit) return { hit, via: 'norm-name' };
    }
  }
  return null;
}

/* ---------- Strapi airline scan ---------- */

async function listAirlinesNeedingCountry() {
  const items = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams();
    qs.append('fields[0]', 'id');
    qs.append('fields[1]', 'documentId');
    qs.append('fields[2]', 'name');
    qs.append('fields[3]', 'iataCode');
    qs.append('fields[4]', 'icaoCode');
    qs.append('fields[5]', 'country');
    qs.set('pagination[page]', String(page));
    qs.set('pagination[pageSize]', '100');
    const r = await strapi(`/api/airlines?${qs.toString()}`);
    for (const item of r.data ?? []) {
      const a = item.attributes ?? item;
      const hasCountry = a.country && String(a.country).trim().length > 0;
      if (hasCountry && !argv.overwrite) continue;
      items.push({
        id: item.id,
        documentId: item.documentId ?? a.documentId,
        name: a.name,
        iataCode: a.iataCode,
        icaoCode: a.icaoCode,
        country: a.country,
      });
    }
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page++;
  }
  return items;
}

/* ---------- Main ---------- */

async function main() {
  console.log('=== FXN airline country fill (OpenFlights) ===');
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');
  if (argv.overwrite) console.log('  [OVERWRITE] Existing country values will also be replaced.');

  const text = await loadOpenFlights();
  const idx = buildIndex(text);

  const airlines = await listAirlinesNeedingCountry();
  console.log(`  ${airlines.length} airlines to look up`);
  if (airlines.length === 0) return;

  let unmatchedSamples = 0;
  const stats = await runConcurrent(airlines, async (airline) => {
    const hit = lookupAirline(airline, idx);
    if (!hit) {
      if (unmatchedSamples < 15) {
        unmatchedSamples++;
        console.warn(`    · no match: "${airline.name}" iata=${airline.iataCode ?? '-'} icao=${airline.icaoCode ?? '-'}`);
      }
      return 'unmatched';
    }
    if (argv['dry-run']) {
      console.log(`    [dry] ${airline.name} (${airline.iataCode ?? '?'}): country ← "${hit.hit.country}" via ${hit.via}`);
      return 'matched';
    }
    const target = airline.documentId ?? airline.id;
    await strapi(`/api/airlines/${target}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { country: hit.hit.country } }),
    });
    return 'matched';
  }, argv.concurrency);

  console.log(`\n=== Done ===`);
  console.log(`  matched (would-write/written): ${stats.matched}`);
  console.log(`  unmatched: ${stats.unmatched}`);
  console.log(`  failed: ${stats.failed}`);
  if (stats.matched > 0 && !argv['dry-run']) {
    console.log(`\n  Next: re-run \`node enrich-region.js --airlines\` to set continents on the newly-filled airlines.`);
  }
}

main().catch((e) => fatal(e.message));
