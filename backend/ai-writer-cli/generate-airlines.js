#!/usr/bin/env node
// FXN AI Writer — Airlines
// Generates Airline directory entries with Claude Opus and posts them to Strapi's /api/airlines.
// Logos are NOT generated (airline trademarks are copyrighted) — upload manually in Strapi admin.
//
// Run interactively:
//   node generate-airlines.js
//
// With flags:
//   node generate-airlines.js --region "Asia-Pacific" --count 10
//   node generate-airlines.js --region Oceania -n 5
//   node generate-airlines.js --type "Low-cost" -n 8 --region Europe
//   node generate-airlines.js --names "Singapore Airlines, Qantas, Emirates" --dry-run

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import slugify from 'slugify';
import { select, input, confirm } from '@inquirer/prompts';

const REGIONS = ['Oceania', 'Asia-Pacific', 'Europe', 'Americas', 'Middle East', 'Africa'];
const TYPES = ['Scheduled', 'Charter', 'Cargo', 'Low-cost', 'Regional'];

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('region', { type: 'string', choices: REGIONS, describe: 'Geographic region to source airlines from' })
  .option('type', { type: 'string', choices: TYPES, describe: 'Limit to a specific airline type' })
  .option('count', { alias: 'n', type: 'number', describe: 'How many airlines to generate' })
  .option('names', { type: 'string', describe: 'Comma-separated list of specific airline names to generate' })
  .option('language', { type: 'string', default: 'English' })
  .option('logos', { type: 'boolean', default: true, describe: 'Attempt to fetch logos from TravelPayouts (pics.avs.io) by IATA code. Use --no-logos to disable.' })
  .option('backfill-logos', { type: 'boolean', default: false, describe: 'Iterate existing airlines missing a logo and try to attach one from TravelPayouts' })
  .option('backfill-countries', { type: 'boolean', default: false, describe: 'Iterate existing airlines with no country and ask Claude for the HQ country based on name/IATA/ICAO' })
  .option('interactive', { alias: 'i', type: 'boolean', default: false })
  .option('dry-run', { type: 'boolean', default: false })
  .help()
  .parseSync();

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-opus-4-7',
  CLAUDE_MAX_TOKENS = '4096',
  STRAPI_URL,
  STRAPI_API_TOKEN,
} = process.env;

if (!ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set.');
if (!argv['dry-run']) {
  if (!STRAPI_URL) fatal('STRAPI_URL is not set in .env');
  if (!STRAPI_API_TOKEN) fatal('STRAPI_API_TOKEN is not set in .env');
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/* ---------- Claude prompts ---------- */

function systemPromptBrainstorm(region, type) {
  const regionHint = region ? `Focus on airlines based or primarily operating in: ${region}.` : 'Pick a globally representative mix.';
  const typeHint = type ? `Type constraint: only ${type} airlines.` : 'Mix of scheduled, low-cost, and regional carriers as appropriate.';
  return `You are a senior aviation editor. Brainstorm a list of real, currently operating airlines.
${regionHint}
${typeHint}
Output MUST be strict JSON: { "airlines": [ { "name": string, "iataCode": string, "icaoCode"?: string, "country": string } ] }
- "name": the canonical English/trading name (e.g. "Singapore Airlines", not "SIA").
- "iataCode": 2-character IATA code (e.g. "SQ", "QF", "VA"). Required for commercial airlines.
- "icaoCode": 3-character ICAO code (e.g. "SIA", "QFA", "VOZ"). Include when known.
- "country": country where the airline is headquartered.
Do not include defunct, merged-away, or hypothetical airlines. Produce DISTINCT entries.
Do not include any text outside the JSON. Do not wrap in markdown fences.`;
}

function userPromptBrainstorm({ region, type, count, language }) {
  return [
    region ? `Region: ${region}` : '',
    type ? `Type: ${type}` : '',
    `Number to generate: ${count}`,
    `Language for names: ${language} (canonical trading spelling)`,
    `Return exactly ${count} entries, no fewer, no more.`,
  ].filter(Boolean).join('\n');
}

function systemPromptAirline() {
  const regionsStr = REGIONS.map((r) => `"${r}"`).join(' | ');
  const typesStr = TYPES.map((t) => `"${t}"`).join(' | ');
  return `You are a senior aviation editor writing an airline directory entry for a travel blog.
Output MUST be strict JSON matching this TypeScript type:
{
  "name": string,            // canonical trading name (e.g. "Singapore Airlines")
  "slug": string,             // kebab-case ASCII, <60 chars, derived from name
  "iataCode": string,         // 2-letter IATA code (uppercase)
  "icaoCode": string,         // 3-letter ICAO code (uppercase), when known
  "legalName": string,        // the full registered legal name (e.g. "Singapore Airlines Limited")
  "type": ${typesStr},
  "country": string,          // REQUIRED. Country where the airline is headquartered. Always include this field.
  "airport": string,          // full name of the main hub airport (e.g. "Singapore Changi Airport")
  "city": string,             // city of the main hub
  "region": ${regionsStr},
  "founded": number,          // 4-digit year only (e.g. 1947). Integer.
  "address": string,          // the airline's headquarters address. Multi-line OK (use \\n).
  "phone": string,            // main customer/corporate phone with country code (e.g. "+65 6223 8888")
  "website": string,          // official website URL (include https://)
  "about": string             // 200-320 words of neutral, factual prose. Cover: founding year and context, hub and primary routes, fleet family (e.g. Airbus A350, Boeing 787), membership of any alliance (Star Alliance / SkyTeam / Oneworld), notable service or loyalty programme, and a one-line honest note (strength or challenge). Plain prose, no markdown, no bullet lists, no headings.
}
All facts must be accurate and current. "name", "slug", "country", "region", and "about" are REQUIRED — never omit them. For other fields (e.g. phone, address, icaoCode), omit rather than invent if you are not sure of an exact value. Do not include any text outside the JSON. Do not wrap in markdown fences.`;
}

function userPromptAirline({ name, iataCode, icaoCode, country, language }) {
  return [
    `Airline: ${name}`,
    iataCode ? `IATA hint: ${iataCode}` : '',
    icaoCode ? `ICAO hint: ${icaoCode}` : '',
    country ? `Country hint: ${country}` : '',
    `Language: ${language}`,
  ].filter(Boolean).join('\n');
}

/* ---------- Claude calls ---------- */

async function brainstormAirlines({ region, type, count, language }) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: systemPromptBrainstorm(region, type),
    messages: [{ role: 'user', content: userPromptBrainstorm({ region, type, count, language }) }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  if (!json || !Array.isArray(json.airlines)) {
    throw new Error(`Claude did not return an airlines array:\n${text.slice(0, 400)}`);
  }
  const seen = new Set();
  const list = json.airlines
    .map((a) => ({
      name: String(a?.name || '').trim(),
      iataCode: a?.iataCode ? String(a.iataCode).trim().toUpperCase().slice(0, 4) : null,
      icaoCode: a?.icaoCode ? String(a.icaoCode).trim().toUpperCase().slice(0, 4) : null,
      country: a?.country ? String(a.country).trim() : null,
    }))
    .filter((a) => {
      const key = a.name.toLowerCase();
      if (!a.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count);
  if (!list.length) throw new Error('Claude returned zero usable airlines.');
  return list;
}

async function generateAirline({ name, iataCode, icaoCode, country, language }) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: parseInt(CLAUDE_MAX_TOKENS, 10),
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: systemPromptAirline(),
    messages: [{ role: 'user', content: userPromptAirline({ name, iataCode, icaoCode, country, language }) }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  if (!json) throw new Error(`Claude returned non-JSON:\n${text.slice(0, 400)}`);
  if (!json.name) json.name = name;
  if (!json.slug) json.slug = slugify(json.name, { lower: true, strict: true }).slice(0, 60);
  if (!json.iataCode && iataCode) json.iataCode = iataCode;
  if (!json.icaoCode && icaoCode) json.icaoCode = icaoCode;
  if (!json.country && country) json.country = country;
  return json;
}

/* ---------- Strapi ---------- */

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

async function findExistingBySlug(slug) {
  const r = await strapi(`/api/airlines?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`);
  return r?.data?.[0] || null;
}

/* ---------- Logo fetch (TravelPayouts / AviaSales pics.avs.io) ---------- */

async function fetchLogoFromTravelPayouts(iataCode) {
  if (!iataCode || iataCode.length < 2) return null;
  const code = iataCode.trim().toUpperCase();
  // Try retina first, then standard. AviaSales CDN responds with a tiny
  // placeholder PNG for unknown codes, so we also guard by content-length.
  const urls = [
    `https://pics.avs.io/200/200/${code}@2x.png`,
    `https://pics.avs.io/200/200/${code}.png`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // Placeholder/empty responses are < 500 bytes. Real logos are > 2KB.
      if (buf.length < 1024) continue;
      return { url, buf, contentType: res.headers.get('content-type') || 'image/png' };
    } catch { /* try next */ }
  }
  return null;
}

async function uploadBufferToStrapi(buf, contentType, filename) {
  const form = new FormData();
  form.append('files', new Blob([buf], { type: contentType }), filename);
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strapi upload ${res.status}: ${body.slice(0, 300)}`);
  }
  const out = await res.json();
  const first = Array.isArray(out) ? out[0] : out;
  if (!first?.id) throw new Error('Strapi upload returned no id');
  return first.id;
}

async function attachLogoByIata({ airlineName, iataCode }) {
  const fetched = await fetchLogoFromTravelPayouts(iataCode);
  if (!fetched) return null;
  const fname = `${slugify(airlineName, { lower: true, strict: true }).slice(0, 50)}-logo.png`;
  return uploadBufferToStrapi(fetched.buf, fetched.contentType, fname);
}

async function updateAirlineLogo(documentId, logoId) {
  return strapi(`/api/airlines/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { logo: logoId } }),
  });
}

async function postToStrapi(draft) {
  const data = {
    name: draft.name,
    slug: draft.slug,
    about: draft.about,
    iataCode: draft.iataCode,
    icaoCode: draft.icaoCode,
    legalName: draft.legalName,
    type: draft.type,
    country: draft.country,
    airport: draft.airport,
    city: draft.city,
    region: draft.region,
    founded: draft.founded,
    address: draft.address,
    phone: draft.phone,
    website: draft.website,
  };
  // Strip undefineds so Strapi doesn't complain on enums
  for (const k of Object.keys(data)) if (data[k] === undefined || data[k] === null || data[k] === '') delete data[k];
  return strapi('/api/airlines', { method: 'POST', body: JSON.stringify({ data }) });
}

/* ---------- Runner ---------- */

async function runOne({ name, iataCode, icaoCode, country, language }) {
  const short = name.slice(0, 40).padEnd(40);
  process.stdout.write(`→ ${short} … `);
  const t0 = Date.now();
  const draft = await generateAirline({ name, iataCode, icaoCode, country, language });
  process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s · `);

  if (argv['dry-run']) {
    console.log('(dry-run)');
    console.log(JSON.stringify(draft, null, 2));
    return;
  }

  const existing = await findExistingBySlug(draft.slug);
  if (existing) {
    console.log(`skipped (slug "${draft.slug}" exists, id=${existing.id})`);
    return;
  }

  const created = await postToStrapi(draft);
  const id = created?.data?.id ?? '?';
  const documentId = created?.data?.documentId;
  let logoTag = '';
  if (argv.logos && documentId && draft.iataCode) {
    try {
      const logoId = await attachLogoByIata({ airlineName: draft.name, iataCode: draft.iataCode });
      if (logoId) {
        await updateAirlineLogo(documentId, logoId);
        logoTag = ` · logo=${logoId}`;
      } else {
        logoTag = ' · logo=n/a';
      }
    } catch (e) {
      logoTag = ` · logo=✖ (${e.message.slice(0, 60)})`;
    }
  }
  console.log(`created id=${id} · ${draft.iataCode || '--'}/${draft.icaoCode || '---'}${logoTag}`);
}

/* ---------- Interactive ---------- */

async function runInteractive() {
  console.log('\nFXN AI Writer — Airlines (interactive)\n');

  const mode = await select({
    message: 'How do you want to seed airlines?',
    choices: [
      { name: 'Brainstorm by region (Claude picks N airlines)', value: 'region' },
      { name: 'I have a specific list of airline names', value: 'names' },
    ],
  });

  let names = null;
  let region = null;
  let type = null;
  let count = 0;

  if (mode === 'names') {
    const raw = await input({
      message: 'Comma-separated airline names (e.g. "Singapore Airlines, Qantas, Virgin Australia"):',
      validate: (v) => v.trim().length > 0 || 'Enter at least one name',
    });
    names = raw.split(',').map((n) => n.trim()).filter(Boolean);
    count = names.length;
  } else {
    region = await select({
      message: 'Region?',
      default: argv.region || 'Asia-Pacific',
      choices: REGIONS.map((r) => ({ name: r, value: r })),
    });

    type = await select({
      message: 'Type (optional, pick "Any" for mixed)?',
      default: argv.type || '__any__',
      choices: [{ name: 'Any', value: '__any__' }, ...TYPES.map((t) => ({ name: t, value: t }))],
    });
    if (type === '__any__') type = null;

    const countStr = await input({
      message: 'How many airlines to generate?',
      default: String(argv.count || 5),
      validate: (v) => {
        const n = Number(v);
        return (Number.isInteger(n) && n > 0 && n <= 50) || 'Enter a whole number between 1 and 50';
      },
    });
    count = Number(countStr);
  }

  const language = await input({
    message: 'Language for descriptions?',
    default: argv.language || 'English',
  });

  argv.region = region || undefined;
  argv.type = type || undefined;
  argv.count = count;
  argv.language = language;

  await runBatch({ names });
}

async function runBatch({ names = null } = {}) {
  const { region, type, count, language } = argv;

  let list;
  if (names && names.length) {
    console.log(`Using explicit list of ${names.length} airline${names.length === 1 ? '' : 's'}.\n`);
    list = names.map((n) => ({ name: n, iataCode: null, icaoCode: null, country: null }));
  } else {
    if (!count) fatal('--count is required (or --names)');
    console.log(`\nBrainstorming ${count} airline${count === 1 ? '' : 's'}${region ? ` in ${region}` : ''}${type ? ` (${type})` : ''} with ${CLAUDE_MODEL}…`);
    list = await brainstormAirlines({ region, type, count, language });
    console.log(`\nGot ${list.length} airline${list.length === 1 ? '' : 's'}:`);
    list.forEach((a, i) => console.log(`  ${String(i + 1).padStart(2)}. ${a.name}${a.iataCode ? ` (${a.iataCode})` : ''}${a.country ? ` — ${a.country}` : ''}`));
    console.log('');
  }

  let ok = 0, fail = 0;
  for (const a of list) {
    try {
      await runOne({ ...a, language });
      ok++;
    } catch (e) {
      console.error(`  ✖ ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone — ${ok} created, ${fail} failed.`);
  if (argv.logos) console.log('ℹ Logos fetched from TravelPayouts (pics.avs.io) when available. Missing ones can be uploaded manually in Strapi admin.');
}

async function resolveCountryFor({ name, iataCode, icaoCode }) {
  const system = `You are a senior aviation editor. Given an airline, return the country where it is headquartered.
Output MUST be strict JSON: { "country": string }
Use the canonical English country name (e.g. "United States", "United Kingdom", "United Arab Emirates").
If you are not confident, return { "country": "" }. Do not invent. Do not include any text outside the JSON.`;
  const user = [
    `Airline: ${name}`,
    iataCode ? `IATA: ${iataCode}` : '',
    icaoCode ? `ICAO: ${icaoCode}` : '',
  ].filter(Boolean).join('\n');
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const json = safeParse(text);
  const country = json?.country ? String(json.country).trim() : '';
  return country || null;
}

async function updateAirlineCountry(documentId, country) {
  return strapi(`/api/airlines/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { country } }),
  });
}

async function runBackfillCountries() {
  console.log('\nBackfilling missing country on airlines via Claude…\n');
  let page = 1, total = 0, ok = 0, skip = 0, fail = 0;
  while (true) {
    const r = await strapi(
      `/api/airlines?filters[country][$null]=true&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    const items = r?.data ?? [];
    if (!items.length) break;
    total += items.length;

    for (const a of items) {
      const name = a.name || `airline-${a.id}`;
      const short = name.slice(0, 40).padEnd(40);
      process.stdout.write(`→ ${short} IATA=${a.iataCode || '--'} · `);
      if (!a.documentId) {
        console.log('skipped (no documentId)');
        skip++;
        continue;
      }
      try {
        const country = await resolveCountryFor({ name, iataCode: a.iataCode, icaoCode: a.icaoCode });
        if (!country) {
          console.log('Claude not confident — skipped');
          skip++;
          continue;
        }
        await updateAirlineCountry(a.documentId, country);
        console.log(`set country="${country}"`);
        ok++;
      } catch (e) {
        console.log(`✖ ${e.message.slice(0, 100)}`);
        fail++;
      }
    }

    if (items.length < 100) break;
    page++;
  }
  console.log(`\nBackfill done — ${ok} updated, ${skip} skipped, ${fail} failed (of ${total} missing-country airlines).`);
}

async function runBackfillLogos() {
  console.log('\nBackfilling logos from TravelPayouts for airlines without one…\n');
  // Fetch in pages of 100, only entries where logo is missing.
  let page = 1, total = 0, ok = 0, skip = 0, fail = 0;
  while (true) {
    const r = await strapi(
      `/api/airlines?populate[logo]=true&filters[logo][id][$null]=true&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    const items = r?.data ?? [];
    if (!items.length) break;
    total += items.length;

    for (const a of items) {
      const name = a.name || `airline-${a.id}`;
      const short = name.slice(0, 40).padEnd(40);
      process.stdout.write(`→ ${short} IATA=${a.iataCode || '--'} · `);
      if (!a.iataCode) {
        console.log('skipped (no IATA code)');
        skip++;
        continue;
      }
      try {
        const logoId = await attachLogoByIata({ airlineName: name, iataCode: a.iataCode });
        if (!logoId) {
          console.log('not found on TravelPayouts');
          skip++;
          continue;
        }
        await updateAirlineLogo(a.documentId, logoId);
        console.log(`attached logo=${logoId}`);
        ok++;
      } catch (e) {
        console.log(`✖ ${e.message.slice(0, 100)}`);
        fail++;
      }
    }

    if (items.length < 100) break;
    page++;
  }
  console.log(`\nBackfill done — ${ok} attached, ${skip} skipped (no IATA or not on CDN), ${fail} failed (of ${total} missing-logo airlines).`);
}

/* ---------- Helpers ---------- */

function safeParse(s) {
  try { return JSON.parse(s); }
  catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}
function fatal(msg) { console.error('✖', msg); process.exit(1); }

/* ---------- Entry ---------- */

async function main() {
  if (argv['backfill-countries']) return runBackfillCountries();
  if (argv['backfill-logos']) return runBackfillLogos();
  if (argv.names) {
    const names = argv.names.split(',').map((n) => n.trim()).filter(Boolean);
    argv.count = names.length;
    return runBatch({ names });
  }
  const hasAllFlags = argv.region && argv.count;
  if (argv.interactive || !hasAllFlags) return runInteractive();
  return runBatch();
}

main().catch((e) => { console.error('\n✖', e.message); process.exit(1); });
