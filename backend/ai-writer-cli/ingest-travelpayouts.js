#!/usr/bin/env node
// TravelPayouts Data API → Strapi bulk ingest
// Pulls airports / airlines / routes from the public TP data dumps and upserts
// into your Strapi instance. Safe to re-run (skips existing by IATA/slug).
//
// Run:
//   node ingest-travelpayouts.js                    # airports + airlines + routes (top 500 routes by default)
//   node ingest-travelpayouts.js --airports-only
//   node ingest-travelpayouts.js --airlines-only
//   node ingest-travelpayouts.js --routes-only --route-limit 1000
//   node ingest-travelpayouts.js --refresh          # force re-download even if cached
//   node ingest-travelpayouts.js --dry-run          # print what would be inserted, no writes
//
// Data source: https://api.travelpayouts.com/data/en/*.json (public, no token needed)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('airports-only', { type: 'boolean', default: false })
  .option('airlines-only', { type: 'boolean', default: false })
  .option('routes-only', { type: 'boolean', default: false })
  .option('countries-only', { type: 'boolean', default: false })
  .option('route-limit', { type: 'number', default: 500, describe: 'Cap number of routes to ingest (by popularity). Use 0 for no cap.' })
  .option('airport-limit', { type: 'number', default: 0, describe: 'Cap number of airports (0 = all commercial/flightable ones)' })
  .option('refresh', { type: 'boolean', default: false, describe: 'Force re-download of TP data dumps (ignore local cache)' })
  .option('concurrency', { type: 'number', default: 6, describe: 'Parallel Strapi write requests' })
  .option('with-logos', { type: 'boolean', default: true, describe: 'For new airlines, fetch logo from pics.avs.io. Use --no-with-logos to skip.' })
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

const DATA_URLS = {
  airports: 'https://api.travelpayouts.com/data/en/airports.json',
  airlines: 'https://api.travelpayouts.com/data/en/airlines.json',
  cities: 'https://api.travelpayouts.com/data/en/cities.json',
  countries: 'https://api.travelpayouts.com/data/en/countries.json',
  routes: 'https://api.travelpayouts.com/data/routes.json',
};

/* ---------- ISO country code → region mapping ---------- */

const REGION_BY_COUNTRY = buildRegionMap();

function buildRegionMap() {
  const map = {};
  const add = (region, codes) => codes.forEach((c) => (map[c] = region));

  add('Oceania', ['AU','NZ','FJ','PG','SB','VU','NC','WS','TO','KI','NR','TV','FM','MH','PW','AS','GU','MP','CK','NU','NF','PN','TK','WF','PF']);
  // Asia = former Asia-Pacific + Middle East
  add('Asia', [
    'CN','JP','KR','KP','TW','HK','MO','IN','PK','BD','LK','NP','BT','MV','AF','ID','MY','SG','TH','VN','LA','KH','MM','PH','BN','MN','TL','KZ','KG','TJ','TM','UZ',
    'AE','SA','KW','BH','QA','OM','YE','IQ','IR','IL','PS','JO','LB','SY',
  ]);
  add('Europe', [
    'AD','AL','AT','BA','BE','BG','BY','CH','CY','CZ','DE','DK','EE','ES','FI','FO','FR','GB','GE','GG','GI','GR','HR','HU','IE','IM','IS','IT','JE','LI','LT','LU','LV','MC','MD','ME','MK','MT','NL','NO','PL','PT','RO','RS','RU','SE','SI','SJ','SK','SM','UA','VA','XK','AM','AZ','TR',
  ]);
  // Americas split: Northern America + Central America + Caribbean → North America;
  // South America stays its own continent.
  add('North America', [
    'US','CA','MX','GL','PA','CR','GT','HN','NI','SV','BZ',
    'CU','DO','HT','JM','BS','BB','TT','GD','LC','VC','KN','AG','DM','CW','AW','BM','PR','VI','TC','KY','MS','AI','VG','SX','BL','MF','PM','BQ','GP','MQ',
  ]);
  add('South America', ['AR','BR','CL','CO','PE','VE','UY','PY','BO','EC','GY','SR','GF','FK']);
  add('Africa', [
    'DZ','AO','BJ','BW','BF','BI','CM','CV','CF','TD','KM','CG','CD','DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','CI','KE','LS','LR','LY','MG','MW','ML','MR','MU','YT','MA','MZ','NA','NE','NG','RE','RW','SH','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','EH','ZM','ZW',
  ]);
  return map;
}

function regionForCountry(cc) {
  if (!cc) return null;
  return REGION_BY_COUNTRY[String(cc).toUpperCase()] || null;
}

/* ---------- Haversine distance ---------- */

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function durationMinutesFromKm(km) {
  // Avg cruising ~870 km/h + 30 min taxi/climb/descent overhead. Rough but useful for display.
  if (!km || km < 100) return null;
  return Math.round((km / 870) * 60) + 30;
}

/* ---------- TP data fetch (cached to /tmp) ---------- */

async function loadDump(name) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (!argv.refresh && fs.existsSync(file)) {
    const ageSec = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
    console.log(`  [cache] ${name}.json (${Math.round(ageSec / 60)} min old, ${fmtBytes(fs.statSync(file).size)})`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const url = DATA_URLS[name];
  process.stdout.write(`  [download] ${url}… `);
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TP download failed: ${res.status}`);
  const body = await res.text();
  fs.writeFileSync(file, body);
  console.log(`${fmtBytes(body.length)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return JSON.parse(body);
}

function fmtBytes(n) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/* ---------- Strapi helpers ---------- */

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

/** Fetch ALL pages of a collection keyed by a unique field. Returns Map<key, {id, documentId}>. */
async function fetchAllAsMap(collection, uniqueField, { select = [] } = {}) {
  const map = new Map();
  let page = 1;
  const pageSize = 100;
  const selectFields = ['id', 'documentId', uniqueField, ...select];
  while (true) {
    const qs = new URLSearchParams();
    selectFields.forEach((f, i) => qs.append(`fields[${i}]`, f));
    qs.set('pagination[page]', page);
    qs.set('pagination[pageSize]', pageSize);
    const r = await strapi(`/api/${collection}?${qs}`);
    for (const item of r.data) {
      const key = item[uniqueField];
      if (key) map.set(String(key).toUpperCase(), { id: item.id, documentId: item.documentId });
    }
    if (!r.data.length || r.data.length < pageSize) break;
    page++;
  }
  return map;
}

async function createRecord(collection, data) {
  return strapi(`/api/${collection}`, { method: 'POST', body: JSON.stringify({ data }) });
}

/** Run an async function over items with a bounded pool of concurrent workers. */
async function runConcurrent(items, worker, concurrency = 6) {
  let idx = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------- Airlines ---------- */

async function ingestAirlines() {
  console.log('\n=== Airlines ===');
  const all = await loadDump('airlines');
  // TP airlines dump fields: { code (IATA), name, is_lowcost, name_translations }
  // No country, no ICAO in this dump — keep bulk-loaded records minimal.
  const filtered = all.filter((a) => a.code && a.code.length === 2 && a.name);
  console.log(`  source: ${all.length} total, ${filtered.length} with 2-char IATA + name`);

  const existing = await fetchAllAsMap('airlines', 'iataCode', { select: [] });
  console.log(`  existing in Strapi: ${existing.size}`);

  const toCreate = filtered.filter((a) => !existing.has(a.code.toUpperCase()));
  console.log(`  to create: ${toCreate.length}${argv['dry-run'] ? ' (DRY RUN)' : ''}`);

  if (argv['dry-run']) {
    toCreate.slice(0, 10).forEach((a) => console.log(`    · ${a.code} ${a.name}${a.is_lowcost ? ' [LCC]' : ''}`));
    if (toCreate.length > 10) console.log(`    … and ${toCreate.length - 10} more`);
    return { airlineMap: existing };
  }

  let ok = 0, fail = 0, withLogo = 0;
  await runConcurrent(toCreate, async (a, i) => {
    const data = {
      name: a.name,
      slug: slugify(a.name, { lower: true, strict: true }).slice(0, 60) || `airline-${a.code.toLowerCase()}`,
      iataCode: a.code.toUpperCase(),
      type: a.is_lowcost ? 'Low-cost' : 'Scheduled',
    };

    try {
      const created = await createRecord('airlines', data);
      const documentId = created?.data?.documentId;
      ok++;
      existing.set(a.code.toUpperCase(), { id: created.data.id, documentId });

      if (argv['with-logos']) {
        const logoId = await attachLogoByIata({ airlineName: a.name, iataCode: a.code });
        if (logoId && documentId) {
          await strapi(`/api/airlines/${documentId}`, {
            method: 'PUT',
            body: JSON.stringify({ data: { logo: logoId } }),
          });
          withLogo++;
        }
      }

      if ((i + 1) % 25 === 0) console.log(`    … ${i + 1}/${toCreate.length}`);
    } catch (e) {
      fail++;
      if (fail < 5) console.error(`    ✖ ${a.code} ${a.name}: ${e.message.slice(0, 100)}`);
    }
  }, argv.concurrency);

  console.log(`  done — created ${ok}, with logo ${withLogo}, failed ${fail}`);
  return { airlineMap: existing };
}

async function fetchLogoFromTravelPayouts(iataCode) {
  if (!iataCode || iataCode.length < 2) return null;
  const code = iataCode.trim().toUpperCase();
  const urls = [
    `https://pics.avs.io/200/200/${code}@2x.png`,
    `https://pics.avs.io/200/200/${code}.png`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) continue;
      return { buf, contentType: res.headers.get('content-type') || 'image/png' };
    } catch { /* try next */ }
  }
  return null;
}

async function attachLogoByIata({ airlineName, iataCode }) {
  const fetched = await fetchLogoFromTravelPayouts(iataCode);
  if (!fetched) return null;
  const form = new FormData();
  const fname = `${slugify(airlineName, { lower: true, strict: true }).slice(0, 50)}-logo.png`;
  form.append('files', new Blob([fetched.buf], { type: fetched.contentType }), fname);
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    body: form,
  });
  if (!res.ok) return null;
  const out = await res.json();
  return (Array.isArray(out) ? out[0] : out)?.id || null;
}

/* ---------- Airports ---------- */

async function ingestAirports() {
  console.log('\n=== Airports ===');
  const all = await loadDump('airports');
  const citiesRaw = await loadDump('cities');
  // Build city_code → { name, country_code } for joining.
  const cityByCode = new Map();
  for (const c of citiesRaw) {
    if (c.code) cityByCode.set(c.code.toUpperCase(), { name: c.name, countryCode: c.country_code });
  }
  console.log(`  cities indexed: ${cityByCode.size}`);

  // TP airports dump fields: { code, name, city_code, country_code, time_zone, coordinates, iata_type, flightable }
  // iata_type values include: "airport", "heliport", etc. Stick to airports with IATA + coords + flightable.
  const filtered = all.filter((a) =>
    a.code && a.code.length === 3 && a.flightable === true && a.coordinates && a.name && a.iata_type === 'airport',
  );
  console.log(`  source: ${all.length} total, ${filtered.length} commercial (flightable airports w/ IATA)`);

  const existing = await fetchAllAsMap('airports', 'iata', { select: [] });
  console.log(`  existing in Strapi: ${existing.size}`);

  let toCreate = filtered.filter((a) => !existing.has(a.code.toUpperCase()));
  if (argv['airport-limit'] > 0) toCreate = toCreate.slice(0, argv['airport-limit']);
  console.log(`  to create: ${toCreate.length}${argv['dry-run'] ? ' (DRY RUN)' : ''}`);

  if (argv['dry-run']) {
    toCreate.slice(0, 10).forEach((a) => {
      const city = cityByCode.get((a.city_code || '').toUpperCase())?.name;
      console.log(`    · ${a.code} ${a.name} — ${city || a.city_code || '?'} (${a.country_code})`);
    });
    if (toCreate.length > 10) console.log(`    … and ${toCreate.length - 10} more`);
    return { airportMap: existing };
  }

  let ok = 0, fail = 0;
  await runConcurrent(toCreate, async (a, i) => {
    const countryCode = a.country_code ? a.country_code.toUpperCase() : null;
    const region = regionForCountry(countryCode);
    const city = cityByCode.get((a.city_code || '').toUpperCase())?.name || null;
    const data = {
      iata: a.code.toUpperCase(),
      name: a.name,
      city,
      countryCode,
      region,
      latitude: a.coordinates?.lat ?? null,
      longitude: a.coordinates?.lon ?? null,
      timezone: a.time_zone || null,
    };
    for (const k of Object.keys(data)) if (data[k] === null || data[k] === '') delete data[k];

    try {
      const created = await createRecord('airports', data);
      existing.set(a.code.toUpperCase(), { id: created.data.id, documentId: created.data.documentId });
      ok++;
      if ((i + 1) % 100 === 0) console.log(`    … ${i + 1}/${toCreate.length}`);
    } catch (e) {
      fail++;
      if (fail < 5) console.error(`    ✖ ${a.code} ${a.name}: ${e.message.slice(0, 100)}`);
    }
  }, argv.concurrency);

  console.log(`  done — created ${ok}, failed ${fail}`);
  return { airportMap: existing };
}

/* ---------- Routes ---------- */

async function ingestRoutes({ airportMap, airlineMap }) {
  console.log('\n=== Routes ===');
  const raw = await loadDump('routes');
  console.log(`  source: ${raw.length.toLocaleString()} carrier-route rows`);

  // Group by (origin IATA, destination IATA), aggregate carriers.
  const grouped = new Map();
  for (const r of raw) {
    const o = (r.departure_airport_iata || '').toUpperCase();
    const d = (r.arrival_airport_iata || '').toUpperCase();
    const a = (r.airline_iata || '').toUpperCase();
    if (!o || !d || o === d) continue;
    const key = `${o}->${d}`;
    if (!grouped.has(key)) grouped.set(key, { origin: o, destination: d, carriers: new Set(), popularity: 0 });
    const entry = grouped.get(key);
    if (a) entry.carriers.add(a);
    entry.popularity += 1; // crude popularity = number of carriers × duplicates
  }
  console.log(`  deduped: ${grouped.size.toLocaleString()} unique routes`);

  // Only keep routes where both endpoints exist in our airport table.
  let kept = [...grouped.values()].filter(
    (r) => airportMap.has(r.origin) && airportMap.has(r.destination),
  );
  console.log(`  resolvable (both airports in Strapi): ${kept.length.toLocaleString()}`);

  // Sort by popularity desc so --route-limit takes the best ones.
  kept.sort((a, b) => b.popularity - a.popularity);
  if (argv['route-limit'] > 0) kept = kept.slice(0, argv['route-limit']);
  console.log(`  to create (after --route-limit): ${kept.length.toLocaleString()}${argv['dry-run'] ? ' (DRY RUN)' : ''}`);

  const existing = await fetchAllAsMap('routes', 'slug', { select: [] });
  console.log(`  existing in Strapi: ${existing.size}`);

  kept = kept.filter((r) => {
    const slug = `${r.origin.toLowerCase()}-to-${r.destination.toLowerCase()}`;
    return !existing.has(slug.toUpperCase()); // fetchAllAsMap upper-cases keys
  });
  console.log(`  net new routes: ${kept.length.toLocaleString()}`);

  if (argv['dry-run']) {
    kept.slice(0, 15).forEach((r) => {
      const carriers = [...r.carriers].join(', ');
      console.log(`    · ${r.origin}→${r.destination} · pop=${r.popularity} · ${carriers}`);
    });
    if (kept.length > 15) console.log(`    … and ${kept.length - 15} more`);
    return;
  }

  // We need airport coordinates for distance. Fetch in bulk.
  const airportMeta = await fetchAirportCoords(airportMap);

  let ok = 0, fail = 0;
  await runConcurrent(kept, async (r, i) => {
    const originMeta = airportMap.get(r.origin);
    const destMeta = airportMap.get(r.destination);
    if (!originMeta || !destMeta) return;

    const coordA = airportMeta.get(r.origin);
    const coordB = airportMeta.get(r.destination);
    const distanceKm = coordA && coordB ? haversineKm(coordA.lat, coordA.lon, coordB.lat, coordB.lon) : null;
    const durationMinutes = durationMinutesFromKm(distanceKm);

    // Map carrier IATA codes → Strapi airline documentIds (skip ones not in our airlines table)
    const carrierDocIds = [...r.carriers]
      .map((iata) => airlineMap.get(iata)?.documentId)
      .filter(Boolean);

    const slug = `${r.origin.toLowerCase()}-to-${r.destination.toLowerCase()}`;
    const data = {
      slug,
      origin: originMeta.documentId,
      destination: destMeta.documentId,
      carriers: carrierDocIds,
      distanceKm,
      durationMinutes,
      popularity: r.popularity,
    };
    for (const k of Object.keys(data)) if (data[k] === null || data[k] === '') delete data[k];

    try {
      await createRecord('routes', data);
      ok++;
      if ((i + 1) % 50 === 0) console.log(`    … ${i + 1}/${kept.length}`);
    } catch (e) {
      fail++;
      if (fail < 5) console.error(`    ✖ ${slug}: ${e.message.slice(0, 100)}`);
    }
  }, argv.concurrency);

  console.log(`  done — created ${ok}, failed ${fail}`);
}

/* ---------- Countries ---------- */

async function ingestCountries() {
  console.log('\n=== Countries ===');
  const all = await loadDump('countries');
  // TP countries dump fields: { code (ISO 2), name, currency, name_translations }
  const filtered = all.filter((c) => c.code && c.code.length === 2 && c.name);
  console.log(`  source: ${all.length} total, ${filtered.length} with 2-char ISO + name`);

  const existing = await fetchAllAsMap('countries', 'code');
  console.log(`  existing in Strapi: ${existing.size}`);

  const toCreate = filtered.filter((c) => !existing.has(c.code.toUpperCase()));
  console.log(`  to create: ${toCreate.length}${argv['dry-run'] ? ' (DRY RUN)' : ''}`);

  if (argv['dry-run']) {
    toCreate.slice(0, 10).forEach((c) => console.log(`    · ${c.code} ${c.name} (${c.currency || '—'})`));
    if (toCreate.length > 10) console.log(`    … and ${toCreate.length - 10} more`);
    return { countryMap: existing };
  }

  let ok = 0, fail = 0;
  await runConcurrent(toCreate, async (c, i) => {
    const data = {
      code: c.code.toUpperCase(),
      name: c.name,
      currency: c.currency || null,
      region: regionForCountry(c.code),
    };
    try {
      const created = await createRecord('countries', data);
      existing.set(c.code.toUpperCase(), { id: created.data.id, documentId: created?.data?.documentId });
      ok++;
      if ((i + 1) % 25 === 0) console.log(`    … ${i + 1}/${toCreate.length}`);
    } catch (e) {
      fail++;
      if (fail < 5) console.error(`    ✖ ${c.code} ${c.name}: ${e.message.slice(0, 100)}`);
    }
  }, argv.concurrency);

  console.log(`  done — created ${ok}, failed ${fail}`);
  return { countryMap: existing };
}

async function fetchAirportCoords(airportMap) {
  // Fetch lat/lon for every airport we already know about. One paginated trip.
  const result = new Map();
  let page = 1;
  const pageSize = 100;
  while (true) {
    const qs = new URLSearchParams();
    qs.append('fields[0]', 'iata');
    qs.append('fields[1]', 'latitude');
    qs.append('fields[2]', 'longitude');
    qs.set('pagination[page]', page);
    qs.set('pagination[pageSize]', pageSize);
    const r = await strapi(`/api/airports?${qs}`);
    for (const a of r.data) {
      if (a.iata && a.latitude != null && a.longitude != null) {
        result.set(a.iata.toUpperCase(), { lat: a.latitude, lon: a.longitude });
      }
    }
    if (!r.data.length || r.data.length < pageSize) break;
    page++;
  }
  return result;
}

/* ---------- Entry ---------- */

function fatal(msg) { console.error('✖', msg); process.exit(1); }

async function main() {
  console.log('TravelPayouts → Strapi ingest');
  console.log(`  Strapi: ${STRAPI_URL || '(dry run)'}`);
  console.log(`  Cache dir: ${CACHE_DIR}`);
  console.log(`  Concurrency: ${argv.concurrency}`);

  let airportMap = null;
  let airlineMap = null;

  const only =
    argv['airports-only'] || argv['airlines-only'] || argv['routes-only'] || argv['countries-only'];

  if (argv['countries-only'] || !only) {
    await ingestCountries();
  }
  if (argv['airports-only'] || (!only && true)) {
    const r = await ingestAirports();
    airportMap = r.airportMap;
  }
  if (argv['airlines-only'] || (!only && true)) {
    const r = await ingestAirlines();
    airlineMap = r.airlineMap;
  }
  if (argv['routes-only'] || (!only && true)) {
    if (!airportMap) airportMap = await fetchAllAsMap('airports', 'iata');
    if (!airlineMap) airlineMap = await fetchAllAsMap('airlines', 'iataCode');
    await ingestRoutes({ airportMap, airlineMap });
  }

  console.log('\nAll done.');
}

main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
