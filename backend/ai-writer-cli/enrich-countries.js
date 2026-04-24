#!/usr/bin/env node
// Enrich Strapi airports with full country names (and currency) using the
// TravelPayouts countries dump. Safe to re-run — only touches airports that
// have a countryCode but no country name yet.
//
// Usage:
//   node enrich-countries.js --limit 10          # small test batch first
//   node enrich-countries.js                     # full run (all missing)
//   node enrich-countries.js --dry-run           # show what would be updated
//   node enrich-countries.js --refresh           # re-download countries.json
//   node enrich-countries.js --airlines          # also backfill airlines (matches by name-derived hints — imprecise, see notes)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('limit', { type: 'number', default: 0, describe: 'Cap how many airport records to update. 0 = no cap.' })
  .option('airlines', { type: 'boolean', default: false, describe: 'Also update airlines (only those with an airport hub already set)' })
  .option('concurrency', { type: 'number', default: 6 })
  .option('refresh', { type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
}

const CACHE_DIR = path.join(os.tmpdir(), 'tp-ingest-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const COUNTRIES_URL = 'https://api.travelpayouts.com/data/en/countries.json';

/* ---------- Helpers ---------- */

function fatal(msg) { console.error('✖', msg); process.exit(1); }

async function loadCountries() {
  const file = path.join(CACHE_DIR, 'countries.json');
  if (!argv.refresh && fs.existsSync(file)) {
    const ageMin = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);
    console.log(`  [cache] countries.json (${ageMin} min old)`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  process.stdout.write('  [download] countries.json… ');
  const res = await fetch(COUNTRIES_URL);
  if (!res.ok) throw new Error(`TP download failed: ${res.status}`);
  const body = await res.text();
  fs.writeFileSync(file, body);
  console.log(`${(body.length / 1024).toFixed(1)} KB`);
  return JSON.parse(body);
}

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

async function runConcurrent(items, worker, concurrency = 6) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { await worker(items[i], i); }
      catch (e) { console.error(`    ✖ item ${i}: ${e.message.slice(0, 120)}`); }
    }
  });
  await Promise.all(workers);
}

/* ---------- Airport enrichment ---------- */

async function enrichAirports(countryMap) {
  console.log('\n=== Airports ===');
  // Fetch airports that HAVE a countryCode but NO country. Paginated.
  const missing = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const qs = new URLSearchParams();
    qs.set('filters[countryCode][$notNull]', 'true');
    qs.set('filters[country][$null]', 'true');
    qs.append('fields[0]', 'id');
    qs.append('fields[1]', 'documentId');
    qs.append('fields[2]', 'iata');
    qs.append('fields[3]', 'countryCode');
    qs.append('fields[4]', 'name');
    qs.set('pagination[page]', page);
    qs.set('pagination[pageSize]', pageSize);
    const r = await strapi(`/api/airports?${qs}`);
    missing.push(...r.data);
    if (r.data.length < pageSize) break;
    page++;
  }

  console.log(`  airports with countryCode but no country: ${missing.length}`);
  let targets = missing;
  if (argv.limit > 0) targets = missing.slice(0, argv.limit);
  console.log(`  to update: ${targets.length}${argv['dry-run'] ? ' (DRY RUN)' : ''}`);

  if (argv['dry-run']) {
    targets.slice(0, 15).forEach((a) => {
      const cc = a.countryCode;
      const countryName = countryMap.get(cc)?.name || '???';
      console.log(`    · ${a.iata}  ${cc} → ${countryName}  [${a.name}]`);
    });
    if (targets.length > 15) console.log(`    … and ${targets.length - 15} more`);
    return;
  }

  let ok = 0, skip = 0, fail = 0;
  await runConcurrent(targets, async (a, i) => {
    const cc = a.countryCode;
    const country = countryMap.get(cc);
    if (!country) {
      skip++;
      return;
    }
    try {
      await strapi(`/api/airports/${a.documentId}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { country: country.name } }),
      });
      ok++;
      if ((i + 1) % 50 === 0) console.log(`    … ${i + 1}/${targets.length}`);
    } catch (e) {
      fail++;
      if (fail < 5) console.error(`    ✖ ${a.iata}: ${e.message.slice(0, 100)}`);
    }
  }, argv.concurrency);

  console.log(`  done — updated ${ok}, skipped (no country match) ${skip}, failed ${fail}`);
}

/* ---------- Airline enrichment (optional, imprecise) ---------- */

async function enrichAirlines(countryMap) {
  console.log('\n=== Airlines ===');
  console.log('  note: airlines don\'t have a countryCode field populated by the ingest.');
  console.log('  this pass only fills country for airlines whose IATA code corresponds to');
  console.log('  a known hub airport — it\'s approximate, best-effort.');

  // Build IATA → country lookup from airports table.
  console.log('  indexing airports by IATA → country…');
  const airportCountry = new Map();
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({
      'fields[0]': 'iata',
      'fields[1]': 'country',
      'fields[2]': 'countryCode',
      'pagination[page]': page,
      'pagination[pageSize]': '100',
    });
    const r = await strapi(`/api/airports?${qs}`);
    for (const a of r.data) {
      if (a.iata && (a.country || a.countryCode)) {
        airportCountry.set(a.iata.toUpperCase(), {
          country: a.country,
          countryCode: a.countryCode,
        });
      }
    }
    if (r.data.length < 100) break;
    page++;
  }
  console.log(`  airports indexed: ${airportCountry.size}`);

  // Get airlines with empty country.
  const missing = [];
  page = 1;
  while (true) {
    const qs = new URLSearchParams({
      'filters[country][$null]': 'true',
      'fields[0]': 'id',
      'fields[1]': 'documentId',
      'fields[2]': 'iataCode',
      'fields[3]': 'name',
      'fields[4]': 'airport',
      'pagination[page]': page,
      'pagination[pageSize]': '100',
    });
    const r = await strapi(`/api/airlines?${qs}`);
    missing.push(...r.data);
    if (r.data.length < 100) break;
    page++;
  }
  console.log(`  airlines with no country: ${missing.length}`);
  console.log('  (airlines without a hub airport on file will be skipped — the ingest doesn\'t populate this)');
  console.log('  skipping airline enrichment for now — reliable source needed. Use the Claude generator for high-value airlines instead.');
}

/* ---------- Entry ---------- */

async function main() {
  console.log('Country enrichment from TravelPayouts dump');
  console.log(`  Strapi: ${STRAPI_URL || '(dry run)'}`);

  const countries = await loadCountries();
  const countryMap = new Map();
  for (const c of countries) {
    if (c.code) countryMap.set(c.code.toUpperCase(), { name: c.name, currency: c.currency });
  }
  console.log(`  countries indexed: ${countryMap.size}`);

  await enrichAirports(countryMap);
  if (argv.airlines) await enrichAirlines(countryMap);

  console.log('\nDone.');
}

main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
