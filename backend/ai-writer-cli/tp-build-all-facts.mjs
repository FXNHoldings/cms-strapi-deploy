#!/usr/bin/env node
// Build consolidated route-network facts for EVERY airline that has route data
// in TravelPayouts, keyed by IATA, into the site's data dir:
//   originfacts.com/data/route-facts/all.json
//
// Free/offline — no API token, no AI. Re-run whenever the tp-data files are
// refreshed. Airlines below the destination threshold are skipped (their
// network is too thin for a meaningful "network overview").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airlineFacts, loadTpData } from './tp-airline-facts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = '/var/www/html/originfacts.com/data/route-facts/all.json';
const MIN_DESTINATIONS = 3; // below this, don't render a network overview

function cleanPlane(n) {
  return n
    .replace(/^Airbus Industrie /, 'Airbus ')
    .replace(/ With Winglets$/, '')
    .replace(/^De Havilland Canada DHC-8[- ]?(\d+)?.*/, (m, d) => (d ? `Dash 8-${d}` : 'Dash 8'))
    .replace(/^Embraer ERJ-(\d+)/, 'Embraer E$1')
    .replace(/^Boeing 777-200\/200ER/, 'Boeing 777-200ER');
}

const tp = loadTpData();
const codes = [...new Set(tp.routes.map((r) => r.airline_iata).filter(Boolean))];

const all = {};
let kept = 0;
let skipped = 0;
for (const code of codes) {
  const f = airlineFacts(code, { maxDestinations: 24 });
  if (!f || f.empty || f.destinationCount < MIN_DESTINATIONS) {
    skipped++;
    continue;
  }
  all[code] = {
    iata: f.iata,
    name: f.name,
    isLowcost: f.isLowcost,
    routeCount: f.routeCount,
    destinationCount: f.destinationCount,
    countryCount: f.countryCount,
    // Store the FULL ranked destination list so the "+N more" control can
    // actually expand it (not just the top slice).
    keyDestinations: f.allDestinations,
    topHubs: f.topHubs,
    fleet: [...new Set(f.fleet.map(cleanPlane))].sort(),
    longestRoute: f.longestRoute,
    source: 'TravelPayouts route data',
    updated: '2026-07',
  };
  kept++;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(all));
const bytes = fs.statSync(OUT).size;
console.log(`Wrote ${OUT}`);
console.log(`  airlines with route data : ${codes.length}`);
console.log(`  kept (>= ${MIN_DESTINATIONS} destinations): ${kept}`);
console.log(`  skipped (too thin)       : ${skipped}`);
console.log(`  file size                : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
