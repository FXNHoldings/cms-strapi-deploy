#!/usr/bin/env node
// TravelPayouts route-data → real airline facts.
//
// Derives grounded, factual route data for an airline from the free
// TravelPayouts reference files (no API token needed):
//   tp-data/routes.json  airlines.json  airports.json  cities.json
//   countries.json  planes.json
//
// For a given airline IATA it computes REAL:
//   - keyDestinations (distinct served cities, by popularity)
//   - destinationCount / countryCount / routeCount
//   - topHubs (busiest departure airports)
//   - fleet (aircraft types operated)
//   - longestRoute (great-circle distance between served airports)
//
// This replaces AI-guessed keyDestinations with authoritative data and lets the
// enrichment answer FAQs ("how many destinations", "longest route", "top
// departure airports") with facts.
//
// CLI:  node tp-airline-facts.js QF            # print facts as text
//       node tp-airline-facts.js QF --json     # machine-readable
//
// Module:  import { airlineFacts, loadTpData } from './tp-airline-facts.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'tp-data');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

let _cache = null;
export function loadTpData() {
  if (_cache) return _cache;
  const airportsArr = readJson('airports.json');
  const citiesArr = readJson('cities.json');
  const countriesArr = readJson('countries.json');
  const planesArr = readJson('planes.json');
  const airlinesArr = readJson('airlines.json');
  const routes = readJson('routes.json');

  const byCode = (arr) => {
    const m = new Map();
    for (const x of arr) if (x && x.code) m.set(x.code, x);
    return m;
  };
  _cache = {
    airports: byCode(airportsArr),
    cities: byCode(citiesArr),
    countries: byCode(countriesArr),
    planes: byCode(planesArr),
    airlines: byCode(airlinesArr),
    routes,
  };
  return _cache;
}

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// Resolve an airport IATA to a friendly { city, country, coords }.
function place(tp, iata) {
  const ap = tp.airports.get(iata);
  if (!ap) return null;
  const city = tp.cities.get(ap.city_code);
  const cc = ap.country_code || city?.country_code;
  const country = cc ? tp.countries.get(cc) : null;
  return {
    iata,
    airport: ap.name,
    city: city?.name || ap.name,
    countryCode: cc || null,
    country: country?.name || null,
    coords: ap.coordinates || city?.coordinates || null,
  };
}

/**
 * Compute real route-derived facts for one airline IATA code.
 * Returns null if the airline has no routes in the dataset.
 */
export function airlineFacts(iata, opts = {}) {
  const code = String(iata || '').toUpperCase();
  if (!code) return null;
  const tp = loadTpData();
  const airline = tp.airlines.get(code);
  const own = tp.routes.filter((r) => r.airline_iata === code);
  if (own.length === 0) return { iata: code, name: airline?.name || null, routeCount: 0, empty: true };

  const destCityCount = new Map(); // city name -> route count (popularity proxy)
  const destCityMeta = new Map(); // city name -> {country}
  const hubCount = new Map(); // departure city name -> count
  const countries = new Set();
  const planeCodes = new Set();
  let longest = null;

  for (const r of own) {
    for (const p of r.planes || []) planeCodes.add(p);

    const dep = place(tp, r.departure_airport_iata);
    const arr = place(tp, r.arrival_airport_iata);

    if (arr) {
      destCityCount.set(arr.city, (destCityCount.get(arr.city) || 0) + 1);
      if (!destCityMeta.has(arr.city)) destCityMeta.set(arr.city, { country: arr.country });
      if (arr.countryCode) countries.add(arr.countryCode);
    }
    if (dep) hubCount.set(dep.city, (hubCount.get(dep.city) || 0) + 1);

    if (dep?.coords && arr?.coords) {
      const km = haversineKm(dep.coords, arr.coords);
      if (km != null && (!longest || km > longest.km)) {
        longest = { km, from: dep.city, to: arr.city, fromIata: dep.iata, toIata: arr.iata };
      }
    }
  }

  const rankedDest = [...destCityCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([city]) => city);
  const topHubs = [...hubCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([city, n]) => ({ city, routes: n }));
  const fleet = [...planeCodes]
    .map((c) => tp.planes.get(c)?.name || c)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  return {
    iata: code,
    name: airline?.name || null,
    isLowcost: airline?.is_lowcost ?? null,
    routeCount: own.length,
    destinationCount: destCityCount.size,
    countryCount: countries.size,
    keyDestinations: rankedDest.slice(0, opts.maxDestinations ?? 12),
    allDestinations: rankedDest,
    topHubs,
    fleet,
    longestRoute: longest,
  };
}

/* ---------- CLI ---------- */
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const iata = process.argv[2];
  const asJson = process.argv.includes('--json');
  if (!iata) {
    console.error('Usage: node tp-airline-facts.js <IATA> [--json]');
    process.exit(1);
  }
  const f = airlineFacts(iata);
  if (asJson) {
    console.log(JSON.stringify(f, null, 2));
  } else if (!f || f.empty) {
    console.log(`No routes found for ${iata} in TravelPayouts data.`);
  } else {
    console.log(`\n${f.name} (${f.iata})${f.isLowcost ? ' · low-cost' : ''}`);
    console.log(`  Routes operated : ${f.routeCount}`);
    console.log(`  Destinations    : ${f.destinationCount} cities across ${f.countryCount} countries`);
    console.log(`  Top hubs        : ${f.topHubs.map((h) => `${h.city} (${h.routes})`).join(', ')}`);
    console.log(`  Longest route   : ${f.longestRoute ? `${f.longestRoute.from} → ${f.longestRoute.to} (${f.longestRoute.km.toLocaleString()} km)` : 'n/a'}`);
    console.log(`  Fleet           : ${f.fleet.slice(0, 12).join(', ')}${f.fleet.length > 12 ? ` +${f.fleet.length - 12} more` : ''}`);
    console.log(`  Key destinations: ${f.keyDestinations.join(', ')}`);
  }
}
