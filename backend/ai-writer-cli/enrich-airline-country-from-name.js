#!/usr/bin/env node
// FXN — Fill empty `country` on airlines by pattern-matching the airline name
// against the canonical countries collection.
//
// Catches obvious cases like "Bhutan Airlines" → Bhutan, "AirAsia Cambodia"
// → Cambodia, "Avianca El Salvador" → El Salvador. Conservative — we only
// match country *names* that appear as whole-word tokens in the airline name,
// and require the airline to currently have NULL country.
//
// We deliberately do NOT match by country code (e.g. "USA"/"UK") because
// 2-letter substrings show up in too many airline names. Names are richer
// and more discriminating.
//
// Run after: deleting non-airlines.
// Run before: invoking Claude as a fallback.
//
// Usage:
//   node enrich-airline-country-from-name.js --dry-run
//   node enrich-airline-country-from-name.js
//   node enrich-airline-country-from-name.js --include-cities    # also try city → country (Beijing→China)

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('include-cities', { type: 'boolean', default: false })
  .option('concurrency', { type: 'number', default: 6 })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');

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

/* ---------- Load canonical country names (and optional city → country) ---------- */

async function loadCanonical() {
  const countries = []; // { name, normalized, regex }
  let page = 1;
  while (true) {
    const r = await strapi(`/api/countries?fields[0]=code&fields[1]=name&pagination[page]=${page}&pagination[pageSize]=100`);
    for (const c of r.data ?? []) {
      const a = c.attributes ?? c;
      if (a.name) countries.push({ name: a.name, code: a.code });
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }

  // Add aliases that appear in airline names but differ from the canonical
  // Strapi country name (mostly common short forms / older spellings).
  const ALIAS = [
    ['United Kingdom', ['UK', 'British', 'Britain']],
    ['United States', ['USA', 'US', 'American']],
    ['Russia', ['Russian Federation', 'Russian']],
    ['China', ['Chinese']],
    ['Korea (Republic of)', ['South Korea', 'Korean']],
    ['South Africa', ['South African']],
    ['Czechia', ['Czech Republic', 'Czech']],
    ['Türkiye', ['Turkey', 'Turkish']],
    ['Viet Nam', ['Vietnam', 'Vietnamese']],
    ['Iran (Islamic Republic of)', ['Iran', 'Iranian']],
    ['Lao People\'s Democratic Republic', ['Laos']],
    ['Myanmar', ['Burma', 'Burmese']],
    ['Brunei Darussalam', ['Brunei']],
  ];
  const byCanonical = new Map(countries.map((c) => [c.name, c]));
  const aliases = [];
  for (const [canonical, alts] of ALIAS) {
    if (byCanonical.has(canonical)) {
      for (const a of alts) aliases.push({ alias: a, canonicalName: canonical });
    }
  }

  // Build a single ordered match list. Longest names first so "United States" beats "States".
  const all = [
    ...countries.map((c) => ({ token: c.name, country: c.name })),
    ...aliases.map((a) => ({ token: a.alias, country: a.canonicalName })),
  ].sort((a, b) => b.token.length - a.token.length);

  console.log(`  loaded ${countries.length} countries + ${aliases.length} aliases`);
  return all;
}

async function loadCities() {
  // Optional: city destinations as country hints.
  const cities = [];
  let page = 1;
  while (true) {
    const r = await strapi(`/api/destinations?filters[type][$eq]=city&filters[countryCode][$notNull]=true&fields[0]=name&fields[1]=countryCode&pagination[page]=${page}&pagination[pageSize]=100`);
    for (const c of r.data ?? []) {
      const a = c.attributes ?? c;
      if (a.name && a.countryCode) cities.push({ name: a.name, countryCode: a.countryCode });
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return cities;
}

async function loadCountryCodeToName() {
  const map = new Map();
  let page = 1;
  while (true) {
    const r = await strapi(`/api/countries?fields[0]=code&fields[1]=name&pagination[page]=${page}&pagination[pageSize]=100`);
    for (const c of r.data ?? []) {
      const a = c.attributes ?? c;
      if (a.code && a.name) map.set(String(a.code).toUpperCase(), a.name);
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return map;
}

/* ---------- Matching ---------- */

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchCountryInName(airlineName, tokens) {
  const lower = ' ' + airlineName.toLowerCase() + ' ';
  for (const t of tokens) {
    // Whole-word match (prevents "USA" matching "Yusafa" or "Britain" matching "Britania").
    const re = new RegExp(`\\b${escapeRegex(t.token.toLowerCase())}\\b`);
    if (re.test(lower)) return { country: t.country, via: t.token };
  }
  return null;
}

function matchCityInName(airlineName, cities, codeToName) {
  const lower = ' ' + airlineName.toLowerCase() + ' ';
  for (const c of cities) {
    const re = new RegExp(`\\b${escapeRegex(c.name.toLowerCase())}\\b`);
    if (re.test(lower)) {
      const country = codeToName.get(String(c.countryCode).toUpperCase());
      if (country) return { country, via: `city:${c.name}` };
    }
  }
  return null;
}

/* ---------- Main ---------- */

async function main() {
  console.log('=== FXN airline country fill (name pattern) ===');
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  const tokens = await loadCanonical();
  let cities = [], codeToName = new Map();
  if (argv['include-cities']) {
    cities = await loadCities();
    codeToName = await loadCountryCodeToName();
    console.log(`  loaded ${cities.length} city → country hints`);
  }

  // List airlines with NULL country.
  const candidates = [];
  let page = 1;
  while (true) {
    const r = await strapi(`/api/airlines?filters[country][$null]=true&fields[0]=id&fields[1]=documentId&fields[2]=name&fields[3]=region&pagination[page]=${page}&pagination[pageSize]=100`);
    for (const a of r.data ?? []) {
      const x = a.attributes ?? a;
      candidates.push({ id: a.id, documentId: a.documentId ?? x.documentId, name: x.name, region: x.region });
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  console.log(`  ${candidates.length} airlines with NULL country to scan\n`);

  let matched = 0, unmatched = 0, failed = 0;
  for (const a of candidates) {
    if (!a.name) { unmatched++; continue; }
    let hit = matchCountryInName(a.name, tokens);
    if (!hit && argv['include-cities']) hit = matchCityInName(a.name, cities, codeToName);
    if (!hit) { unmatched++; continue; }

    matched++;
    if (argv['dry-run']) {
      console.log(`    [dry] ${a.name.padEnd(45)} → ${hit.country}  (via "${hit.via}")`);
      continue;
    }
    try {
      const target = a.documentId ?? a.id;
      await strapi(`/api/airlines/${target}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { country: hit.country } }),
      });
      console.log(`    ✓ ${a.name.padEnd(45)} → ${hit.country}  (via "${hit.via}")`);
    } catch (e) {
      failed++;
      console.error(`    ✖ ${a.name}: ${e.message.slice(0, 120)}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  matched: ${matched}`);
  console.log(`  unmatched: ${unmatched}`);
  console.log(`  failed: ${failed}`);
  if (matched > 0 && !argv['dry-run']) {
    console.log('\n  Next: re-run `node enrich-region.js --airlines` to set continents.');
  }
}

main().catch((e) => fatal(e.message));
