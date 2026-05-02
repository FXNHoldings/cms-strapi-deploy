#!/usr/bin/env node
// FXN — Phase 1 country seeder.
//
// Pulls country reference data from REST Countries (https://restcountries.com)
// and creates two rows per country in Strapi:
//   1. countries(code, name, currency, region)
//   2. destinations(type=country, slug, name, countryCode)
// Both rows are linked implicitly by ISO 3166-1 alpha-2 code (`code` ↔ `countryCode`).
//
// Idempotent: skips countries already present (matched by code/countryCode).
// No AI, no images. Run enrich-* scripts later for prose + heroes.
//
// Usage:
//   node seed-countries.js --codes "TH,VN,JP,ID,AU,NZ"          # explicit list
//   node seed-countries.js --from-airports                       # ISO codes from existing airports
//   node seed-countries.js --all                                 # every REST Countries entry (~250)
//   node seed-countries.js --codes TH --dry-run                  # show what would happen
//   node seed-countries.js --codes TH,VN --skip-destinations     # only seed countries collection
//   node seed-countries.js --codes TH,VN --skip-countries        # only seed destinations collection

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('codes', { type: 'string', describe: 'Comma-separated ISO 3166-1 alpha-2 codes (e.g. TH,VN,JP)' })
  .option('from-airports', { type: 'boolean', default: false, describe: 'Use distinct countryCodes from existing airports' })
  .option('all', { type: 'boolean', default: false, describe: 'Seed every country in REST Countries (~250)' })
  .option('skip-countries', { type: 'boolean', default: false, describe: 'Do not write the countries collection' })
  .option('skip-destinations', { type: 'boolean', default: false, describe: 'Do not write the destinations collection' })
  .option('concurrency', { type: 'number', default: 4 })
  .option('dry-run', { type: 'boolean', default: false })
  .check((a) => {
    const sources = [a.codes, a['from-airports'], a.all].filter(Boolean).length;
    if (sources === 0) throw new Error('Pick a source: --codes, --from-airports, or --all');
    if (sources > 1) throw new Error('Pick exactly one source: --codes, --from-airports, or --all');
    return true;
  })
  .help()
  .parseSync();

const { STRAPI_URL, STRAPI_API_TOKEN } = process.env;
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
}

/* ------------------------------------------------------------------ */
/* REST Countries → 6-continent enum                                  */
/*                                                                    */
/* REST Countries returns `region` (Africa/Americas/Asia/Europe/      */
/* Oceania/Antarctic) and `subregion` (e.g. "South America",          */
/* "Caribbean"). We split Americas using subregion; everything else   */
/* maps 1:1 except Antarctic (skipped — no countries).                */
/* ------------------------------------------------------------------ */

function continentFor({ region, subregion }) {
  switch (region) {
    case 'Africa': return 'Africa';
    case 'Asia':   return 'Asia';
    case 'Europe': return 'Europe';
    case 'Oceania':return 'Oceania';
    case 'Americas': {
      if (subregion === 'South America') return 'South America';
      // Northern America, Central America, Caribbean → North America.
      return 'North America';
    }
    default: return null; // Antarctic / unknown
  }
}

/* ---------- Helpers ---------- */

function fatal(msg) { console.error('✖', msg); process.exit(1); }

function safeSlug(name) {
  return slugify(name, { lower: true, strict: true });
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

async function runConcurrent(items, worker, concurrency = 4) {
  let idx = 0;
  const stats = { created: 0, skipped: 0, failed: 0 };
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        const result = await worker(items[i], i);
        if (result === 'created') stats.created++;
        else if (result === 'skipped') stats.skipped++;
      } catch (e) {
        stats.failed++;
        console.error(`    ✖ ${items[i]?.cca2 ?? i}: ${e.message.slice(0, 140)}`);
      }
    }
  });
  await Promise.all(workers);
  return stats;
}

/* ---------- Source resolution ---------- */

async function loadAllRestCountries() {
  process.stdout.write('  [download] restcountries.com … ');
  const url = 'https://restcountries.com/v3.1/all?fields=cca2,name,currencies,region,subregion';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`REST Countries ${res.status}`);
  const data = await res.json();
  console.log(`${data.length} countries`);
  return data;
}

async function isoCodesFromAirports() {
  const set = new Set();
  let page = 1;
  while (true) {
    const qs = new URLSearchParams();
    qs.set('filters[countryCode][$notNull]', 'true');
    qs.append('fields[0]', 'countryCode');
    qs.set('pagination[page]', String(page));
    qs.set('pagination[pageSize]', '100');
    const r = await strapi(`/api/airports?${qs.toString()}`);
    for (const a of r.data ?? []) {
      const cc = a.attributes?.countryCode ?? a.countryCode;
      if (cc) set.add(String(cc).toUpperCase());
    }
    const total = r.meta?.pagination?.pageCount ?? 1;
    if (page >= total) break;
    page++;
  }
  return [...set].sort();
}

async function pickCountries(allRC) {
  if (argv.codes) {
    const wanted = new Set(argv.codes.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
    const matched = allRC.filter((c) => wanted.has(String(c.cca2).toUpperCase()));
    const found = new Set(matched.map((c) => String(c.cca2).toUpperCase()));
    const missing = [...wanted].filter((c) => !found.has(c));
    if (missing.length) console.warn(`  ⚠ Unknown ISO codes ignored: ${missing.join(', ')}`);
    return matched;
  }
  if (argv['from-airports']) {
    const codes = await isoCodesFromAirports();
    console.log(`  [from-airports] ${codes.length} distinct country codes`);
    if (codes.length === 0) {
      console.warn('  ⚠ No airports with countryCode found — nothing to seed.');
      return [];
    }
    const set = new Set(codes);
    return allRC.filter((c) => set.has(String(c.cca2).toUpperCase()));
  }
  // --all
  return allRC;
}

/* ---------- Strapi lookups ---------- */

async function findCountryByCode(code) {
  const qs = new URLSearchParams();
  qs.set('filters[code][$eqi]', code);
  qs.append('fields[0]', 'id');
  qs.append('fields[1]', 'code');
  qs.set('pagination[pageSize]', '1');
  const r = await strapi(`/api/countries?${qs.toString()}`);
  return r.data?.[0] ?? null;
}

async function findDestinationCountryByCode(code) {
  const qs = new URLSearchParams();
  qs.set('filters[type][$eq]', 'country');
  qs.set('filters[countryCode][$eqi]', code);
  qs.append('fields[0]', 'id');
  qs.append('fields[1]', 'slug');
  qs.set('pagination[pageSize]', '1');
  const r = await strapi(`/api/destinations?${qs.toString()}`);
  return r.data?.[0] ?? null;
}

async function findDestinationBySlug(slug) {
  const qs = new URLSearchParams();
  qs.set('filters[slug][$eq]', slug);
  qs.append('fields[0]', 'id');
  qs.append('fields[1]', 'slug');
  qs.set('pagination[pageSize]', '1');
  const r = await strapi(`/api/destinations?${qs.toString()}`);
  return r.data?.[0] ?? null;
}

/* ---------- Per-country worker ---------- */

async function processCountry(rc) {
  const code = String(rc.cca2 ?? '').toUpperCase();
  const name = rc?.name?.common;
  if (!code || !name) {
    console.warn(`    ⚠ skipping malformed entry: ${JSON.stringify(rc).slice(0, 80)}`);
    return 'skipped';
  }

  const continent = continentFor({ region: rc.region, subregion: rc.subregion });
  if (!continent) {
    console.warn(`    ⚠ ${code} ${name}: no continent mapping (region=${rc.region}) — skipped`);
    return 'skipped';
  }

  const currency = rc.currencies ? Object.keys(rc.currencies)[0] : null;
  const slug = safeSlug(name);

  /* --- countries collection --- */
  let countryAction = 'skipped';
  if (!argv['skip-countries']) {
    const existing = await findCountryByCode(code);
    if (existing) {
      countryAction = 'skipped';
    } else {
      const body = {
        data: {
          code,
          name,
          ...(currency ? { currency } : {}),
          region: continent,
        },
      };
      if (argv['dry-run']) {
        console.log(`    [dry] CREATE country ${code} ${name} (${continent}${currency ? ', ' + currency : ''})`);
      } else {
        await strapi('/api/countries', { method: 'POST', body: JSON.stringify(body) });
      }
      countryAction = 'created';
    }
  }

  /* --- destinations collection (type=country) --- */
  let destAction = 'skipped';
  if (!argv['skip-destinations']) {
    const existingDest = await findDestinationCountryByCode(code);
    if (existingDest) {
      destAction = 'skipped';
    } else {
      // Slug must be globally unique on destinations. If a city/region already owns this slug,
      // suffix with -country to avoid a 400.
      let finalSlug = slug;
      if (await findDestinationBySlug(finalSlug)) finalSlug = `${slug}-country`;

      const body = {
        data: {
          name,
          slug: finalSlug,
          type: 'country',
          countryCode: code,
        },
      };
      if (argv['dry-run']) {
        console.log(`    [dry] CREATE destination ${code} ${name} (slug=${finalSlug})`);
      } else {
        await strapi('/api/destinations', { method: 'POST', body: JSON.stringify(body) });
      }
      destAction = 'created';
    }
  }

  if (countryAction === 'created' || destAction === 'created') {
    console.log(`    ✓ ${code} ${name} → ${continent} (countries:${countryAction}, dest:${destAction})`);
    return 'created';
  }
  console.log(`    · ${code} ${name} already present`);
  return 'skipped';
}

/* ---------- Main ---------- */

async function main() {
  console.log('=== FXN country seeder (Phase 1) ===');
  if (argv['dry-run']) console.log('  [DRY RUN] No writes will happen.');

  const all = await loadAllRestCountries();
  const picked = await pickCountries(all);
  if (picked.length === 0) {
    console.log('Nothing to seed.');
    return;
  }
  console.log(`  Seeding ${picked.length} countr${picked.length === 1 ? 'y' : 'ies'} with concurrency ${argv.concurrency}.\n`);

  const stats = await runConcurrent(picked, processCountry, argv.concurrency);

  console.log(`\n=== Done ===`);
  console.log(`  created: ${stats.created}`);
  console.log(`  skipped: ${stats.skipped}`);
  console.log(`  failed : ${stats.failed}`);
}

main().catch((e) => fatal(e.message));
