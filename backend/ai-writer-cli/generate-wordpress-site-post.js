#!/usr/bin/env node

// Content Jobs entry point for the WordPress-backed Strapi collections.
// Generation and persistence stay in generate-site-post.js so all site writers
// share the same provider, image, category, validation, and dry-run behaviour.

const allowedSites = new Set(['flightfares.one', 'globalscholar.one']);
const siteArg = process.argv.find((arg) => arg.startsWith('--site='));
const site = siteArg ? siteArg.slice('--site='.length) : null;

if (!process.argv.includes('--help') && !site) {
  console.error('A target site is required.');
  process.exit(1);
}

if (site && !allowedSites.has(site)) {
  console.error('Use --site=flightfares.one or --site=globalscholar.one');
  process.exit(1);
}

import('./generate-site-post.js');
