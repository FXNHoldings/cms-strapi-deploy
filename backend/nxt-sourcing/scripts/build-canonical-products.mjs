/**
 * Turn a plain list of product names into a canonical-products JSON file.
 *
 *   node scripts/build-canonical-products.mjs <list.txt> [more.txt ...] [--out=dir] [--dry-run]
 *
 * The category is taken from the file name, so "Smart Home Security.txt" becomes
 * category "Smart Home Security" in smart-home-security.json.
 *
 * Brands are RESOLVED, never invented. data/canonical-products/README.md is
 * explicit that identifiers must not be guessed, and the same reasoning applies
 * to the brand: a wrong one produces confident searches for the wrong product.
 * Two sources are allowed, both evidence:
 *
 *   1. the line already starts with a brand ("Levoit Core 400S Smart Air Purifier")
 *   2. a bare line is the tail of a branded line elsewhere in the input, so the
 *      list itself supplies the mapping — "Core 400S Smart Air Purifier" resolves
 *      to Levoit because that longer line exists
 *
 * Anything still unresolved keeps `brand: ""` and is reported, rather than being
 * assigned a plausible-looking guess. Those rows are the ones a human should
 * look at before sourcing runs against them.
 *
 * Everything written is a search *hypothesis*, not a fact: identifiers stay
 * empty and identifierStatus stays needs_verification, matching the existing
 * laptop.json and headphones.json.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const outDir = (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1]
  || path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'data', 'canonical-products');

if (!files.length) {
  console.error('usage: build-canonical-products.mjs <list.txt> [...] [--out=dir] [--dry-run]');
  process.exit(1);
}

/* Brand vocabulary. Every entry below appears verbatim in the source lists —
   this is a lookup table for text already present, not outside knowledge.
   Longest-first so "TP-Link Kasa" wins over "TP-Link" and "Google Nest" over
   "Google". */
const BRANDS = [
  'TP-Link', 'Philips Hue', 'GE Cync',
  'Google', 'Amazon', 'Apple',
  'Home Assistant', 'Honeywell Home', 'Lutron Caséta', 'Lutron Caseta', 'Lutron',
  'Leviton', 'Chamberlain myQ', 'Chamberlain', 'Hubitat Elevation',
  'Hubitat', 'Samsung SmartThings', 'Samsung', 'Orbit B-hyve', 'Orbit',
  'Emerson', 'iRobot', 'Sonos', 'Bose', 'JBL',
  'Roku', 'LG', 'Sony', 'Hisense', 'TCL', 'Ring', 'Blink', 'Arlo', 'EufyCam',
  'eufyCam', 'Eufy', 'Wyze', 'Aqara', 'Level', 'Schlage', 'Yale', 'Ecobee',
  'Mysa', 'Emporia', 'Sense', 'Shelly', 'Sonoff', 'Meross', 'SwitchBot',
  'Inovelli', 'Eve', 'Flic', 'Roborock', 'Dreame', 'Ecovacs', 'Shark', 'Dyson',
  'Levoit', 'Coway', 'Blueair', 'Dreo', 'PETLIBRO', 'Rachio', 'ChargePoint',
  'Tesla', 'Autel', 'EcoFlow', 'Jackery', 'Bluetti', 'Anker', 'Rheem', 'Aeotec',
  'Homey', 'IKEA', 'Bond', 'eero', 'Deco', 'Whisker', 'RYSE', 'Meater', 'Anova',
  'Traeger', 'Withings', 'Nanoleaf', 'Govee', 'WiZ', 'Wemo', 'Reolink', 'Lorex',
  'Kasa', 'Tapo', 'Cync', 'Nest', 'Roomba', 'Sensi', 'Refoss', 'Wiser', 'Hue',
  'Caseta', 'Caséta', 'Litter-Robot', 'SmartThings', 'Instant', 'NVIDIA', 'Elgato',
].sort((a, b) => b.length - a.length);

/* Accessories and listing noise that pollute smart-home searches. Category
   specific, exactly as laptop.json excludes "keyboard cover" and headphones.json
   excludes "ear tips". */
const GLOBAL_EXCLUDE = [
  'case', 'cover', 'skin', 'sticker', 'decal', 'mount', 'bracket', 'wall plate',
  'faceplate', 'replacement filter', 'replacement part', 'power adapter',
  'charger', 'charging cable', 'usb cable', 'for parts', 'parts only',
  'dummy', 'display model', 'manual only',
];
const CONDITION_EXCLUDE = ['refurbished', 'renewed', 'used', 'open box'];

const SPLIT_LATER = ['color', 'packSize', 'generation', 'region', 'connectivity', 'mountType'];

/* Terms that carry no discriminating power in a product search. Kept small: a
   term removed here can no longer separate two similar products. */
const STOP = new Set([
  'the', 'and', 'with', 'for', 'a', 'an', 'of', 'in', 'to', 'as', 'plus',
  'smart', 'wi-fi', 'wifi', 'new', 'latest', 'newest',
]);

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Repair UTF-8 read as Latin-1 ("CasÃ©ta" -> "Caséta"), which is how these
 *  lists arrive from spreadsheet exports. */
function fixMojibake(s) {
  if (!/[ÃÂ]/.test(s)) return s;
  try {
    return Buffer.from(s, 'latin1').toString('utf8');
  } catch {
    return s;
  }
}

function detectBrand(name) {
  for (const b of BRANDS) {
    if (name.toLowerCase().startsWith(`${b.toLowerCase()} `)) return b;
  }
  return null;
}

function tokens(name) {
  return name
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9+.\- ]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((t) => t && t.length > 1 && !STOP.has(t));
}

/* ------------------------------------------------------------------ read -- */

const lists = files.map((f) => {
  const category = fixMojibake(path.basename(f).replace(/\.txt$/i, '').trim());
  const lines = fs.readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => fixMojibake(l).trim())
    .filter(Boolean);
  return { file: f, category, lines };
});

// A branded line anywhere in the input can resolve a bare line in any file, so
// the index is built across all of them before anything is emitted.
const brandedIndex = [];
for (const { lines } of lists) {
  for (const line of lines) {
    const brand = detectBrand(line);
    if (brand) brandedIndex.push({ brand, full: line, tail: line.slice(brand.length).trim() });
  }
}

/** Punctuation carries no meaning across these lists: one writes
 *  "Nest Doorbell (Wired, 3rd Gen)" and another "Nest Doorbell Wired, 3rd Gen".
 *  Comparing on normalised text matches those without loosening the rule that a
 *  brand must come from evidence. */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Resolve a bare name by finding a branded line whose tail is the same product. */
function resolveBare(name) {
  const target = norm(name);
  const hit = brandedIndex.find((b) => norm(b.tail) === target);
  return hit ? { brand: hit.brand, canonical: hit.full, via: 'tail-match' } : null;
}

/**
 * Weaker but still evidential: the product LINE appears under exactly one brand
 * elsewhere in the lists. "Fire TV Stick 4K Select" has no exact twin, but
 * "Amazon Fire TV Stick 4K Max" establishes that the Fire TV Stick line is
 * Amazon's.
 *
 * Only accepted when the line maps to a single brand. If two brands share a
 * leading pair — as generic openers like "Smart Plug" would — it stays
 * unresolved rather than picking one, because a confidently wrong brand is
 * worse here than a blank a human will fill in.
 */
function resolveByFamily(name) {
  const t = norm(name).split(' ');
  if (t.length < 2) return null;
  const prefix = t.slice(0, 2).join(' ');
  const brands = [...new Set(
    brandedIndex
      .filter((b) => { const n = norm(b.tail); return n === prefix || n.startsWith(`${prefix} `); })
      .map((b) => b.brand),
  )];
  return brands.length === 1 ? { brand: brands[0], canonical: name, via: 'family-match' } : null;
}

/* ----------------------------------------------------------------- build -- */

const summary = [];

for (const { category, lines } of lists) {
  const seen = new Map();
  const unresolved = [];

  for (const raw of lines) {
    let brand = detectBrand(raw);
    let canonical = raw;
    let via = brand ? 'prefix' : null;

    if (!brand) {
      const resolved = resolveBare(raw) ?? resolveByFamily(raw);
      if (resolved) ({ brand, canonical, via } = resolved);
    }

    if (!brand) {
      brand = '';
      unresolved.push(raw);
    }

    // Same product reached from a bare and a branded line collapses here.
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;

    /*
     * Only strip the brand when the name actually begins with it. A
     * family-match resolves the brand from a *different* line, so the canonical
     * name here is still the bare one — slicing brand.length off it chops real
     * characters and yields families like "r Shade" from "Roller Shade".
     */
    const model = brand && canonical.toLowerCase().startsWith(`${brand.toLowerCase()} `)
      ? canonical.slice(brand.length).trim()
      : canonical;
    // Family is the product line: the first couple of model tokens, before the
    // size/generation qualifiers that distinguish variants within it.
    const family = model.split(/[,(]/)[0].trim().split(/\s+/).slice(0, 2).join(' ') || model;

    seen.set(key, {
      brand,
      family,
      model,
      canonicalName: canonical,
      requiredTerms: [...new Set(tokens(canonical))].slice(0, 8),
      brandResolution: via ?? 'unresolved',
    });
  }

  // Group variants under brand + family, as laptop.json does.
  const byFamily = new Map();
  for (const v of seen.values()) {
    const k = `${v.brand}::${v.family}`;
    if (!byFamily.has(k)) byFamily.set(k, { brand: v.brand, family: v.family, category, sourceStatus: 'seed', variants: [] });
    byFamily.get(k).variants.push({
      canonicalName: v.canonicalName,
      model: v.model,
      identifierStatus: 'needs_verification',
      identifiers: {},
      brandResolution: v.brandResolution,
      requiredTerms: v.requiredTerms,
      excludeTerms: [...GLOBAL_EXCLUDE, ...CONDITION_EXCLUDE],
      searchQueries: [
        v.canonicalName,
        `${v.canonicalName} smart home`,
        `${v.brand ? `${v.brand} ` : ''}${v.model}`.trim(),
      ].filter((q, i, a) => q && a.indexOf(q) === i),
      variantsToSplitLater: SPLIT_LATER,
    });
  }

  const doc = {
    schemaVersion: 1,
    category,
    defaultCountry: 'US',
    defaultCurrency: 'USD',
    globalExcludeTerms: GLOBAL_EXCLUDE,
    families: [...byFamily.values()].sort((a, b) => (a.brand || 'zzz').localeCompare(b.brand || 'zzz') || a.family.localeCompare(b.family)),
  };

  const outPath = path.join(outDir, `${slug(category)}.json`);
  if (!DRY) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  }

  const variantCount = doc.families.reduce((n, f) => n + f.variants.length, 0);
  summary.push({ category, outPath, lines: lines.length, families: doc.families.length, variants: variantCount, unresolved });
}

/* ---------------------------------------------------------------- report -- */

console.log(DRY ? 'DRY RUN — nothing written\n' : `written to ${outDir}\n`);
for (const s of summary) {
  console.log(`${s.category}`);
  console.log(`  ${path.basename(s.outPath)}  ${s.lines} lines -> ${s.families} families, ${s.variants} variants`);
  if (s.unresolved.length) {
    console.log(`  ${s.unresolved.length} without a resolvable brand (left blank, not guessed):`);
    for (const u of s.unresolved.slice(0, 6)) console.log(`      ${u}`);
    if (s.unresolved.length > 6) console.log(`      ... and ${s.unresolved.length - 6} more`);
  }
  console.log();
}
