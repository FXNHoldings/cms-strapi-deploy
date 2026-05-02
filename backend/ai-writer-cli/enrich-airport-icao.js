#!/usr/bin/env node
// FXN — Backfill ICAO codes on airports from OpenFlights airports.dat.
//
// Joins by IATA (we have 100% IATA coverage). Idempotent — only fills airports
// whose `icao` is empty/null. Free, deterministic, ~30 seconds for the full
// 3,662-airport dataset.
//
// OpenFlights `airports.dat` columns:
//   ID, Name, City, Country, IATA, ICAO, Lat, Lng, Alt, Tz, DST, TzDb, Type, Source
//
// Usage:
//   node enrich-airport-icao.js --dry-run     # preview
//   node enrich-airport-icao.js               # apply
//   node enrich-airport-icao.js --refresh     # re-download airports.dat
//   node enrich-airport-icao.js --overwrite   # also rewrite existing ICAO values

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('concurrency', { type: 'number', default: 8 })
  .option('refresh', { type: 'boolean', default: false })
  .option('overwrite', { type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');

const OPENFLIGHTS_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';
const CACHE_DIR = path.join(os.tmpdir(), 'fxn-openflights-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_FILE = path.join(CACHE_DIR, 'airports.dat');

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

async function loadOpenFlights() {
  if (!argv.refresh && fs.existsSync(CACHE_FILE)) {
    const ageMin = Math.round((Date.now() - fs.statSync(CACHE_FILE).mtimeMs) / 60000);
    console.log(`  [cache] airports.dat (${ageMin} min old)`);
    return fs.readFileSync(CACHE_FILE, 'utf8');
  }
  process.stdout.write('  [download] OpenFlights airports.dat … ');
  const res = await fetch(OPENFLIGHTS_URL);
  if (!res.ok) throw new Error(`OpenFlights ${res.status}`);
  const body = await res.text();
  fs.writeFileSync(CACHE_FILE, body);
  console.log(`${(body.length / 1024).toFixed(1)} KB`);
  return body;
}

function buildIataIcaoIndex(text) {
  const byIata = new Map();
  let lines = 0, withIcao = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    const cols = parseCsvLine(line);
    if (cols.length < 6) continue;
    const iata = cols[4];
    const icao = cols[5];
    if (!iata || iata === '\\N' || iata === '-' || iata.length !== 3) continue;
    if (!icao || icao === '\\N' || icao === '-' || icao.length !== 4) continue;
    byIata.set(iata.toUpperCase(), icao.toUpperCase());
    withIcao++;
  }
  console.log(`  parsed ${withIcao}/${lines} OpenFlights rows with IATA+ICAO`);
  return byIata;
}

async function main() {
  console.log('=== FXN airport ICAO backfill (OpenFlights) ===');
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');
  if (argv.overwrite) console.log('  [OVERWRITE] Existing ICAO values will also be replaced.');

  const text = await loadOpenFlights();
  const idx = buildIataIcaoIndex(text);

  // Pull airports needing ICAO.
  const candidates = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams();
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
      const hasIcao = a.icao && String(a.icao).trim().length > 0;
      if (hasIcao && !argv.overwrite) continue;
      if (!a.iata) continue;
      candidates.push({
        id: item.id,
        documentId: item.documentId ?? a.documentId,
        iata: a.iata,
        icao: a.icao,
        name: a.name,
      });
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  console.log(`  ${candidates.length} airports to look up`);
  if (candidates.length === 0) return;

  let unmatchedSamples = 0;
  const stats = await runConcurrent(candidates, async (apt) => {
    const icao = idx.get(apt.iata.toUpperCase());
    if (!icao) {
      if (unmatchedSamples < 10) {
        unmatchedSamples++;
        console.warn(`    · no ICAO for ${apt.iata} (${apt.name})`);
      }
      return 'unmatched';
    }
    if (argv['dry-run']) {
      console.log(`    [dry] ${apt.iata} ${apt.name.padEnd(40)} icao ← ${icao}`);
      return 'matched';
    }
    const target = apt.documentId ?? apt.id;
    await strapi(`/api/airports/${target}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { icao } }),
    });
    return 'matched';
  }, argv.concurrency);

  console.log(`\n=== Done ===`);
  console.log(`  matched (would-write/written): ${stats.matched}`);
  console.log(`  unmatched: ${stats.unmatched}`);
  console.log(`  failed: ${stats.failed}`);
}

main().catch((e) => fatal(e.message));
