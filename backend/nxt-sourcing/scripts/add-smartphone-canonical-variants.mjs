#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(ROOT, 'data', 'canonical-products', 'smartphones.json');

const names = `
Apple iPhone 15 128GB
Apple iPhone 15 256GB
Apple iPhone 15 512GB
Apple iPhone 15 Plus 128GB
Apple iPhone 15 Plus 256GB
Apple iPhone 15 Plus 512GB
Apple iPhone 15 Pro 128GB
Apple iPhone 15 Pro 256GB
Apple iPhone 15 Pro 512GB
Apple iPhone 15 Pro 1TB
Apple iPhone 15 Pro Max 256GB
Apple iPhone 15 Pro Max 512GB
Apple iPhone 15 Pro Max 1TB
Apple iPhone 16 128GB
Apple iPhone 16 256GB
Apple iPhone 16 512GB
Apple iPhone 16 Plus 128GB
Apple iPhone 16 Plus 256GB
Apple iPhone 16 Plus 512GB
Apple iPhone 16e 128GB
Apple iPhone 16e 256GB
Apple iPhone 16e 512GB
Apple iPhone 16 Pro 128GB
Apple iPhone 16 Pro 256GB
Apple iPhone 16 Pro 512GB
Apple iPhone 16 Pro 1TB
Apple iPhone 16 Pro Max 256GB
Apple iPhone 16 Pro Max 512GB
Apple iPhone 16 Pro Max 1TB
Apple iPhone 17 256GB
Apple iPhone 17 512GB
Apple iPhone 17 Air 256GB
Apple iPhone 17 Air 512GB
Apple iPhone 17 Air 1TB
Apple iPhone 17 Pro 256GB
Apple iPhone 17 Pro 512GB
Apple iPhone 17 Pro 1TB
Apple iPhone 17 Pro Max 256GB
Apple iPhone 17 Pro Max 512GB
Apple iPhone 17 Pro Max 1TB
Apple iPhone 17 Pro Max 2TB
Apple iPhone 17e 256GB
Apple iPhone 17e 512GB
Google Pixel 7 128GB
Google Pixel 7 256GB
Google Pixel 7 Pro 128GB
Google Pixel 7 Pro 256GB
Google Pixel 7 Pro 512GB
Google Pixel 7a 128GB
Google Pixel 8 128GB
Google Pixel 8 256GB
Google Pixel 8 Pro 128GB
Google Pixel 8 Pro 256GB
Google Pixel 8 Pro 512GB
Google Pixel 8 Pro 1TB
Google Pixel 8a 128GB
Google Pixel 8a 256GB
Google Pixel Fold 256GB
Google Pixel Fold 512GB
Google Pixel 9 128GB
Google Pixel 9 256GB
Google Pixel 9 Pro 128GB
Google Pixel 9 Pro 256GB
Google Pixel 9 Pro 512GB
Google Pixel 9 Pro 1TB
Google Pixel 9 Pro XL 128GB
Google Pixel 9 Pro XL 256GB
Google Pixel 9 Pro XL 512GB
Google Pixel 9 Pro XL 1TB
Google Pixel 9 Pro Fold 256GB
Google Pixel 9 Pro Fold 512GB
Google Pixel 9a 128GB
Google Pixel 9a 256GB
Google Pixel 10 128GB
Google Pixel 10 256GB
Google Pixel 10 Pro 128GB
Google Pixel 10 Pro 256GB
Google Pixel 10 Pro 512GB
Google Pixel 10 Pro 1TB
Google Pixel 10 Pro XL 256GB
Google Pixel 10 Pro XL 512GB
Google Pixel 10 Pro XL 1TB
Google Pixel 10 Pro Fold 256GB
Google Pixel 10 Pro Fold 512GB
Google Pixel 10 Pro Fold 1TB
Google Pixel 10a 128GB
Google Pixel 10a 256GB
Samsung Galaxy S26 256GB
Samsung Galaxy S26 512GB
Samsung Galaxy S26+ 256GB
Samsung Galaxy S26+ 512GB
Samsung Galaxy S26 Ultra 256GB
Samsung Galaxy S26 Ultra 512GB
Samsung Galaxy S26 Ultra 1TB
Samsung Galaxy S25 FE 128GB
Samsung Galaxy S25 FE 256GB
Samsung Galaxy S25 Edge 256GB
Samsung Galaxy S25 Edge 512GB
`;

const storagePattern = /\s(128GB|256GB|512GB|1TB|2TB)$/;
const baseExcludeTerms = ['case', 'refurbished', 'renewed', 'used'];

function releaseYear(model) {
  if (/iPhone 15/.test(model)) return 2023;
  if (/iPhone 16/.test(model)) return 2024;
  if (/iPhone 17/.test(model)) return 2025;
  if (/Pixel (7|7a|Fold)/.test(model)) return 2022;
  if (/Pixel (8|8a)/.test(model)) return 2023;
  if (/Pixel (9|9a)/.test(model)) return 2024;
  if (/Pixel (10|10a)/.test(model)) return 2025;
  if (/Galaxy S25/.test(model)) return 2025;
  if (/Galaxy S26/.test(model)) return 2026;
  return undefined;
}

function familyFor(name) {
  if (name.startsWith('Apple ')) return { brand: 'Apple', family: 'iPhone' };
  if (name.startsWith('Google ')) return { brand: 'Google', family: 'Pixel' };
  if (name.startsWith('Samsung ')) return { brand: 'Samsung', family: 'Galaxy S' };
  throw new Error(`Unknown brand for ${name}`);
}

function termsFor(name, model, storage) {
  return [...new Set(
    name
      .replace(/^Apple |^Google |^Samsung /, '')
      .replace(/\+/g, ' plus ')
      .split(/\s+/)
      .concat([storage])
      .map((term) => term.toLowerCase())
      .filter(Boolean),
  )];
}

function variantFor(name) {
  const storage = name.match(storagePattern)?.[1];
  if (!storage) throw new Error(`Missing storage in ${name}`);
  const model = name.replace(/^Apple |^Google |^Samsung /, '').replace(storagePattern, '');
  return {
    canonicalName: name,
    model,
    storage,
    ...(releaseYear(model) ? { releaseYear: releaseYear(model) } : {}),
    identifierStatus: 'needs_verification',
    identifiers: {},
    requiredTerms: termsFor(name, model, storage),
    excludeTerms: baseExcludeTerms,
    searchQueries: [`${name} unlocked`, `${name} new unlocked`],
    variantsToSplitLater: ['color', 'carrier', 'region'],
  };
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));

for (const name of names.split('\n').map((line) => line.trim()).filter(Boolean)) {
  const target = familyFor(name);
  const family = data.families.find((item) => item.brand === target.brand && item.family === target.family);
  if (!family) throw new Error(`Missing family ${target.brand} ${target.family}`);
  if (family.variants.some((variant) => variant.canonicalName === name)) continue;
  family.variants.push(variantFor(name));
}

for (const family of data.families) {
  family.variants.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName, 'en', { numeric: true }));
}

writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
