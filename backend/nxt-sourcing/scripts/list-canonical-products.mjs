#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, 'data', 'canonical-products');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateVariant(file, family, variant) {
  const errors = [];
  const label = `${file}: ${family.brand || 'Unknown'} ${variant.canonicalName || variant.model || '(unnamed)'}`;

  if (!variant.canonicalName) errors.push(`${label} is missing canonicalName`);
  if (!variant.model) errors.push(`${label} is missing model`);
  if (!Array.isArray(variant.requiredTerms) || variant.requiredTerms.length === 0) {
    errors.push(`${label} is missing requiredTerms`);
  }
  if (!Array.isArray(variant.searchQueries) || variant.searchQueries.length === 0) {
    errors.push(`${label} is missing searchQueries`);
  }

  return errors;
}

function loadFiles() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(DIR, name);
      return { name, data: JSON.parse(readFileSync(path, 'utf8')) };
    });
}

const rows = [];
const errors = [];

for (const file of loadFiles()) {
  for (const family of asArray(file.data.families)) {
    for (const variant of asArray(family.variants)) {
      errors.push(...validateVariant(file.name, family, variant));
      rows.push({
        file: file.name,
        category: file.data.category || family.category || '',
        brand: family.brand || '',
        family: family.family || '',
        canonicalName: variant.canonicalName || '',
        identifierStatus: variant.identifierStatus || 'unknown',
        queries: asArray(variant.searchQueries).length,
      });
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.table(rows);
console.log(`Canonical products: ${rows.length}`);
