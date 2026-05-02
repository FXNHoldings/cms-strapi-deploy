#!/usr/bin/env node
// FXN — Backfill `region` (continent) on airports + airlines.
//
// Why: we changed the region enum from
//   ['Oceania','Asia-Pacific','Europe','Americas','Middle East','Africa']
// to the 6-continent model
//   ['Africa','Asia','Europe','North America','Oceania','South America']
// so existing rows with stale values (or null) need fresh ones.
//
// Airports use `countryCode`; airlines use `country` (name string). We handle
// both — code→continent for airports, name→continent for airlines.
//
// Source of truth for code→continent: the `countries` collection (populated
// by seed-countries.js). Hard-coded fallbacks cover the gaps.
//
// Usage:
//   node enrich-region.js --dry-run     # preview both
//   node enrich-region.js               # apply both
//   node enrich-region.js --airports    # only airports
//   node enrich-region.js --airlines    # only airlines

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('airports', { type: 'boolean', default: false })
  .option('airlines', { type: 'boolean', default: false })
  .option('concurrency', { type: 'number', default: 6 })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const doAirports = argv.airports || (!argv.airports && !argv.airlines);
const doAirlines = argv.airlines || (!argv.airports && !argv.airlines);

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');

const STALE_VALUES = new Set(['Asia-Pacific', 'Americas', 'Middle East']);

/* ---------- Country code → continent fallback (mirrors ingest-travelpayouts.js) ---------- */

const FALLBACK_BY_CODE = (() => {
  const map = {};
  const add = (region, codes) => codes.forEach((c) => (map[c] = region));
  add('Oceania', ['AU','NZ','FJ','PG','SB','VU','NC','WS','TO','KI','NR','TV','FM','MH','PW','AS','GU','MP','CK','NU','NF','PN','TK','WF','PF']);
  add('Asia', [
    'CN','JP','KR','KP','TW','HK','MO','IN','PK','BD','LK','NP','BT','MV','AF','ID','MY','SG','TH','VN','LA','KH','MM','PH','BN','MN','TL','KZ','KG','TJ','TM','UZ',
    'AE','SA','KW','BH','QA','OM','YE','IQ','IR','IL','PS','JO','LB','SY',
  ]);
  add('Europe', [
    'AD','AL','AT','BA','BE','BG','BY','CH','CY','CZ','DE','DK','EE','ES','FI','FO','FR','GB','GE','GG','GI','GR','HR','HU','IE','IM','IS','IT','JE','LI','LT','LU','LV','MC','MD','ME','MK','MT','NL','NO','PL','PT','RO','RS','RU','SE','SI','SJ','SK','SM','UA','VA','XK','AM','AZ','TR',
  ]);
  add('North America', [
    'US','CA','MX','GL','PA','CR','GT','HN','NI','SV','BZ',
    'CU','DO','HT','JM','BS','BB','TT','GD','LC','VC','KN','AG','DM','CW','AW','BM','PR','VI','TC','KY','MS','AI','VG','SX','BL','MF','PM','BQ','GP','MQ',
  ]);
  add('South America', ['AR','BR','CL','CO','PE','VE','UY','PY','BO','EC','GY','SR','GF','FK']);
  add('Africa', [
    'DZ','AO','BJ','BW','BF','BI','CM','CV','CF','TD','KM','CG','CD','DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','CI','KE','LS','LR','LY','MG','MW','ML','MR','MU','YT','MA','MZ','NA','NE','NG','RE','RW','SH','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','EH','ZM','ZW',
  ]);
  return map;
})();

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
  const stats = { updated: 0, failed: 0 };
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        const r = await worker(items[i]);
        if (r === 'updated') stats.updated++;
      } catch (e) {
        stats.failed++;
        console.error(`    ✖ ${items[i]?.id}: ${e.message.slice(0, 140)}`);
      }
    }
  });
  await Promise.all(workers);
  return stats;
}

async function loadCountriesMap() {
  // Returns { byCode: { US: 'North America', ... }, byName: { 'united states': 'North America', ... } }.
  // Built off the Strapi `countries` collection — single source of truth.
  const byCode = {};
  const byName = {};
  let page = 1;
  while (true) {
    const qs = new URLSearchParams();
    qs.append('fields[0]', 'code');
    qs.append('fields[1]', 'name');
    qs.append('fields[2]', 'region');
    qs.set('pagination[page]', String(page));
    qs.set('pagination[pageSize]', '100');
    const r = await strapi(`/api/countries?${qs.toString()}`);
    for (const c of r.data ?? []) {
      const a = c.attributes ?? c;
      if (a?.region) {
        if (a.code) byCode[String(a.code).toUpperCase()] = a.region;
        if (a.name) byName[String(a.name).trim().toLowerCase()] = a.region;
      }
    }
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page++;
  }
  return { byCode, byName };
}

function continentForCode(code, strapiByCode) {
  if (!code) return null;
  const cc = String(code).toUpperCase();
  return strapiByCode[cc] ?? FALLBACK_BY_CODE[cc] ?? null;
}

// Map weird input spellings (from Wikidata, OpenFlights, etc.) → Strapi
// canonical country names (which come from REST Countries, lower-cased).
const NAME_ALIASES = {
  // United States
  'usa': 'united states',
  'us': 'united states',
  'united states of america': 'united states',
  // China & SARs
  "people's republic of china": 'china',
  'hong kong sar of china': 'hong kong',
  'hong kong sar': 'hong kong',
  'macao': 'macau',
  'macao sar of china': 'macau',
  // Korea
  'republic of korea': 'south korea',
  'korea (republic of)': 'south korea',
  'korea, republic of': 'south korea',
  "korea (democratic people's republic of)": 'north korea',
  "democratic people's republic of korea": 'north korea',
  // Congo (two countries)
  'democratic republic of the congo': 'dr congo',
  'congo (kinshasa)': 'dr congo',
  'congo, the democratic republic of the': 'dr congo',
  'congo (brazzaville)': 'republic of the congo',
  'congo, republic of the': 'republic of the congo',
  // Côte d'Ivoire — both quote forms + paren form
  "côte d'ivoire": 'ivory coast',
  "côte d’ivoire": 'ivory coast',
  "côte d'ivoire (ivory coast)": 'ivory coast',
  "côte d’ivoire (ivory coast)": 'ivory coast',
  // Taiwan
  'taiwan (republic of china)': 'taiwan',
  'taiwan, province of china': 'taiwan',
  'republic of china': 'taiwan',
  // Other variants
  'czech republic': 'czechia',
  'east timor': 'timor-leste',
  'reunion': 'réunion',
  'burma': 'myanmar',
};

/* ---------- Country NAME → continent (mirrors enrich-airlines.js) ---------- */

const NAME_TO_CONTINENT = (() => {
  const map = {};
  const add = (region, names) => names.forEach((n) => (map[n.toLowerCase()] = region));
  add('Oceania', ['Australia', 'New Zealand', 'Fiji', 'Papua New Guinea', 'Samoa', 'Tonga', 'Vanuatu']);
  add('Asia', [
    'Japan', 'China', "People's Republic of China", 'South Korea', 'Korea', 'Taiwan', 'Hong Kong', 'Macau',
    'Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines', 'Cambodia', 'Laos',
    'Myanmar', 'Brunei', 'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Bhutan', 'Mongolia', 'Maldives',
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
})();

function continentForName(name, strapiByName) {
  if (!name) return null;
  const k = String(name).trim().toLowerCase();
  // 1. Strapi countries (canonical) — primary source.
  if (strapiByName[k]) return strapiByName[k];
  // 2. Alias → re-lookup against Strapi.
  const aliased = NAME_ALIASES[k];
  if (aliased && strapiByName[aliased]) return strapiByName[aliased];
  // 3. Fallback to hard-coded name list.
  return NAME_TO_CONTINENT[k] ?? null;
}

/* ---------- Per-collection enrichment ---------- */

async function enrichAirports(strapiByCode) {
  console.log('\n=== Airports ===');
  const stale = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams();
    qs.append('fields[0]', 'id');
    qs.append('fields[1]', 'documentId');
    qs.append('fields[2]', 'countryCode');
    qs.append('fields[3]', 'region');
    qs.set('pagination[page]', String(page));
    qs.set('pagination[pageSize]', '100');
    const r = await strapi(`/api/airports?${qs.toString()}`);
    for (const item of r.data ?? []) {
      const a = item.attributes ?? item;
      if (!a.countryCode) continue;
      if (a.region && !STALE_VALUES.has(a.region)) continue;
      stale.push({
        id: item.id,
        documentId: item.documentId ?? a.documentId,
        countryCode: a.countryCode,
        currentRegion: a.region ?? '(null)',
      });
    }
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page++;
  }

  if (stale.length === 0) {
    console.log('  · no airports need updating');
    return;
  }
  console.log(`  ${stale.length} airports to update`);

  const stats = await runConcurrent(stale, async (item) => {
    const next = continentForCode(item.countryCode, strapiByCode);
    if (!next) {
      console.warn(`    ⚠ ${item.id} ${item.countryCode}: no continent mapping`);
      return null;
    }
    if (argv['dry-run']) {
      console.log(`    [dry] ${item.id} ${item.countryCode}: ${item.currentRegion} → ${next}`);
      return 'updated';
    }
    const target = item.documentId ?? item.id;
    await strapi(`/api/airports/${target}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { region: next } }),
    });
    return 'updated';
  }, argv.concurrency);

  console.log(`  airports updated: ${stats.updated}, failed: ${stats.failed}`);
}

async function enrichAirlines(strapiByName) {
  console.log('\n=== Airlines ===');
  const stale = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams();
    qs.append('fields[0]', 'id');
    qs.append('fields[1]', 'documentId');
    qs.append('fields[2]', 'country');
    qs.append('fields[3]', 'region');
    qs.append('fields[4]', 'name');
    qs.set('pagination[page]', String(page));
    qs.set('pagination[pageSize]', '100');
    const r = await strapi(`/api/airlines?${qs.toString()}`);
    for (const item of r.data ?? []) {
      const a = item.attributes ?? item;
      if (a.region && !STALE_VALUES.has(a.region)) continue;
      stale.push({
        id: item.id,
        documentId: item.documentId ?? a.documentId,
        country: a.country,
        name: a.name,
        currentRegion: a.region ?? '(null)',
      });
    }
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page++;
  }

  if (stale.length === 0) {
    console.log('  · no airlines need updating');
    return;
  }
  console.log(`  ${stale.length} airlines to update`);

  let unresolved = 0;
  const stats = await runConcurrent(stale, async (item) => {
    const next = continentForName(item.country, strapiByName);
    if (!next) {
      unresolved++;
      if (unresolved <= 10) {
        console.warn(`    ⚠ "${item.name}" (country="${item.country ?? ''}"): no continent — skipped`);
      }
      return null;
    }
    if (argv['dry-run']) {
      console.log(`    [dry] ${item.name} (${item.country}): ${item.currentRegion} → ${next}`);
      return 'updated';
    }
    const target = item.documentId ?? item.id;
    await strapi(`/api/airlines/${target}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { region: next } }),
    });
    return 'updated';
  }, argv.concurrency);

  console.log(`  airlines updated: ${stats.updated}, failed: ${stats.failed}, unresolved: ${unresolved}`);
}

/* ---------- Main ---------- */

async function main() {
  console.log('=== FXN region enrichment ===');
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  const { byCode, byName } = await loadCountriesMap();
  console.log(`  loaded ${Object.keys(byCode).length} country→continent rows from Strapi`);

  if (doAirports) await enrichAirports(byCode);
  if (doAirlines) await enrichAirlines(byName);
}

main().catch((e) => fatal(e.message));
