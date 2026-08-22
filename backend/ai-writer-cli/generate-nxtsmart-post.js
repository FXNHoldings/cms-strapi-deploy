#!/usr/bin/env node
// FXN AI Writer - NXTSmart.Homes post generator
//
// Dedicated entrypoint for /var/www/html/nxtsmart.homes, which reads posts from
// the Strapi /api/nxtsmart-posts collection and categories from
// /api/nxtsmart-categories.
//
// This delegates to generate-site-post.js so provider handling, image
// generation, Strapi upload, duplicate checks, and topic-file support stay in
// one maintained implementation.
//
// Examples:
//   node generate-nxtsmart-post.js --category smart-home-security --count 5
//   node generate-nxtsmart-post.js "Best Matter smart plugs for beginners" --category product-reviews
//   node generate-nxtsmart-post.js --topics topics.txt --no-images
//   node generate-nxtsmart-post.js --category how-to-guides --count 2 --publish
//   node generate-nxtsmart-post.js --dry-run --category smart-home-automation --count 1

const args = process.argv.slice(2);
const hasSiteFlag = args.some((arg) => arg === "--site" || arg === "-s" || arg.startsWith("--site="));

process.argv = [
  process.argv[0],
  new URL("./generate-site-post.js", import.meta.url).pathname,
  ...(hasSiteFlag ? [] : ["--site", "nxtsmart.homes"]),
  ...args,
];

await import("./generate-site-post.js");
