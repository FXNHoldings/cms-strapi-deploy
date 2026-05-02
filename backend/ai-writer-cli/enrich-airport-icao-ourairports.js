#!/usr/bin/env node
// FXN — Second-pass ICAO backfill from OurAirports.
//
// OpenFlights stops at ~2017; OurAirports is community-maintained and current
// (covers BER Berlin Brandenburg → EDDB, AYJ Ayodhya → VIDX, etc.). We run
// this AFTER enrich-airport-icao.js to fill what OpenFlights missed.
//
// CSV format: id, ident, type, name, ..., iata_code, ...
//   - `ident` is the ICAO code (4 letters) for major airports, or a synthetic
//     identifier for others. We only accept it when ident matches /^[A-Z]{4}$/
//     and the row's type is one of {large_airport, medium_airport, small_airport}.
//
// Usage:
//   node enrich-airport-icao-ourairports.js --dry-run
//   node enrich-airport-icao-ourairports.js
//   node enrich-airport-icao-ourairports.js --refresh

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('concurrency', { type: 'number', default: 8 })
  .option('refresh', { type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');

const SOURCE_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const CACHE_DIR = path.join(os.tmpdir(), 'fxn-ourairports-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_FILE = path.join(CACHE_DIR, 'airports.csv');

function fatal(m) { console.error('✖', m); process.exit(1); }

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Strapi ${res.status} on ${pathname}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function runConcurrent(items, worker, concurrency) {
  let idx = 0;
  const stats = { matched: 0, unmatched: 0, failed: 0 };
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        const r = await worker(items[i]);
        if (r === 'matched') stats.matched++;
        else if (r === 'unmatched') stats.unmatched++;
      } catch (e) {
        stats.failed++;
        console.error(`    ✖ ${items[i]?.iata}: ${e.message.slice(0, 140)}`);
      }
    }
  });
  await Promise.all(workers);
  return stats;
}

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

async function load() {
  if (!argv.refresh && fs.existsSync(CACHE_FILE)) {
    const ageMin = Math.round((Date.now() - fs.statSync(CACHE_FILE).mtimeMs) / 60000);
    console.log(`  [cache] OurAirports airports.csv (${ageMin} min old)`);
    return fs.readFileSync(CACHE_FILE, 'utf8');
  }
  process.stdout.write('  [download] OurAirports airports.csv … ');
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`OurAirports ${res.status}`);
  const body = await res.text();
  fs.writeFileSync(CACHE_FILE, body);
  console.log(`${(body.length / 1024).toFixed(1)} KB`);
  return body;
}

function buildIataIcaoIndex(text) {
  const lines = text.split('\n');
  const header = parseCsvLine(lines[0]);
  const col = (name) => header.indexOf(name);
  const iIata = col('iata_code');
  const iIdent = col('ident');
  const iType = col('type');
  const iName = col('name');
  if (iIata < 0 || iIdent < 0 || iType < 0) {
    throw new Error(`OurAirports CSV header missing expected columns: ${header.slice(0, 10).join(',')}…`);
  }

  const byIata = new Map();
  let total = 0, kept = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    total++;
    const cols = parseCsvLine(lines[i]);
    const iata = (cols[iIata] ?? '').trim();
    const ident = (cols[iIdent] ?? '').trim();
    const type = (cols[iType] ?? '').trim();
    if (!/^[A-Z]{3}$/.test(iata)) continue;
    if (!/^[A-Z]{4}$/.test(ident)) continue;
    if (!['large_airport', 'medium_airport', 'small_airport'].includes(type)) continue;
    // Prefer larger airport types when there's a duplicate IATA.
    const existing = byIata.get(iata);
    if (existing) {
      const rank = (t) => ({ large_airport: 3, medium_airport: 2, small_airport: 1 }[t] ?? 0);
      if (rank(type) <= rank(existing.type)) continue;
    }
    byIata.set(iata, { ident, type, name: cols[iName] });
    kept++;
  }
  console.log(`  parsed ${kept}/${total} OurAirports rows with IATA+ICAO+type`);
  return byIata;
}

async function main() {
  console.log('=== FXN airport ICAO backfill (OurAirports — second pass) ===');
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  const text = await load();
  const idx = buildIataIcaoIndex(text);

  // Strapi airports without ICAO, with valid IATA.
  const candidates = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams();
    qs.set('filters[$or][0][icao][$null]', 'true');
    qs.set('filters[$or][1][icao][$eq]', '');
    qs.append('fields[0]', 'id');
    qs.append('fields[1]', 'documentId');
    qs.append('fields[2]', 'iata');
    qs.append('fields[3]', 'icao');
    qs.append('fields[4]', 'name');
    qs.set('pagination[page]', String(page));
    qs.set('pagination[pageSize]', '100');
    const r = await strapi(`/api/airports?${qs.toString()}`);
    for (const item of r.data ?? []) {
      const a = item.attributes ?? item;
      if (!a.iata || !/^[A-Z]{3}$/.test(a.iata)) continue;
      candidates.push({
        id: item.id,
        documentId: item.documentId ?? a.documentId,
        iata: a.iata,
        name: a.name,
      });
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  console.log(`  ${candidates.length} airports still missing ICAO`);
  if (candidates.length === 0) return;

  let unmatchedSamples = 0;
  const stats = await runConcurrent(candidates, async (apt) => {
    const hit = idx.get(apt.iata.toUpperCase());
    if (!hit) {
      if (unmatchedSamples < 10) {
        unmatchedSamples++;
        console.warn(`    · ${apt.iata}  ${apt.name}`);
      }
      return 'unmatched';
    }
    if (argv['dry-run']) {
      console.log(`    [dry] ${apt.iata}  ${(apt.name ?? '').padEnd(40)} icao ← ${hit.ident}  (${hit.type})`);
      return 'matched';
    }
    const target = apt.documentId ?? apt.id;
    await strapi(`/api/airports/${target}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { icao: hit.ident } }),
    });
    return 'matched';
  }, argv.concurrency);

  console.log(`\n=== Done ===`);
  console.log(`  matched: ${stats.matched}`);
  console.log(`  unmatched: ${stats.unmatched}`);
  console.log(`  failed: ${stats.failed}`);
}

main().catch((e) => fatal(e.message));
