#!/usr/bin/env node
// FXN AI Writer - nxtsmarthome.com.au post generator
//
// Entrypoint for /opt/projects/nxtsmarthome.com.au (the Australian smart home
// site), which reads posts from Strapi /api/nxtsmarthome-posts and categories
// from /api/nxtsmarthome-categories. Not to be confused with
// generate-nxtsmart-post.js, which writes for nxtsmart.homes.
//
// Delegates to generate-site-post.js (site "nxtsmarthome.com.au"), so AI
// provider handling, images, Strapi upload and duplicate checks stay in one
// place. Run with no arguments to be prompted for everything: the category list
// comes live from Strapi and shows the site's own names (Security & Cameras,
// Energy & Solar, ...), then post type, count/topic, publishing, images and
// length.
//
// Examples:
//   node generate-nxtsmarthome-post.js
//   node generate-nxtsmarthome-post.js --category lighting --count 2
//   node generate-nxtsmarthome-post.js "Best smart plugs for Australian homes" --category energy --post-type buying-guide
//   node generate-nxtsmarthome-post.js --category security --count 5 --publishedAt "2026-10-01 09:00" --publish-every 24
//   node generate-nxtsmarthome-post.js --dry-run --category climate --count 1
//
// Categories (Strapi slug): security, lighting, energy, entertainment, climate,
// hubs-and-platforms, robot-vacuums, setup-guides, buying-guides.
//
// Publishing: drafts by default; --publish goes live now; --publishedAt
// <date/time> saves it Published with showFrom = that time, and the site keeps
// it hidden until then (no timezone = Australia/Perth). --publish-every <hours>
// staggers a batch.
//
// Site rules (projects/nxtsmarthome.com.au/CLAUDE.md) still apply after
// generation: Australian English, no invented prices/specs/ratings, [VERIFY]
// on legal and safety claims, and at least two ::product:<slug>:: boxes
// (node scripts/link-products.mjs <slug>) before an article is published.

const args = process.argv.slice(2);
const hasSiteFlag = args.some((arg) => arg === "--site" || arg === "-s" || arg.startsWith("--site="));

process.argv = [
  process.argv[0],
  new URL("./generate-site-post.js", import.meta.url).pathname,
  ...(hasSiteFlag ? [] : ["--site", "nxtsmarthome.com.au"]),
  ...args,
];

await import("./generate-site-post.js");
