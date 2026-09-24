#!/usr/bin/env node
// FXN AI Writer - bestlooking.skin post generator
//
// Entrypoint for /opt/projects/bestlooking.skin, which reads posts from Strapi
// /api/bls-posts and categories from /api/bls-categories.
//
// Delegates to generate-site-post.js (site "bestlooking.skin"). Run with no
// arguments to be prompted for everything: the category list comes live from
// Strapi, grouped by hub (By Product › Serums, By Concern › Acne,
// Cross-Cutting › Routines, ...) and limited to the topic hubs posts are filed
// under - the retired format categories and the group parents are not offered.
// Then post type (informative, how-to, review, comparison, roundup, top-rated,
// pillar), count/topic, publishing, images and length.
//
// Examples:
//   node generate-bestlooking-post.js
//   node generate-bestlooking-post.js --category serums --count 2
//   node generate-bestlooking-post.js "Niacinamide vs vitamin C: which first?" --category ingredients --post-type informative
//   node generate-bestlooking-post.js --category acne --count 3 --publishedAt "2026-10-01 08:00" --publish-every 24
//   node generate-bestlooking-post.js --dry-run --category routines --count 1
//
// Content is HTML (bls-post.content is rendered as HTML). Publishing: drafts
// by default; --publish goes live now; --publishedAt <date/time> saves it
// Published with showFrom = that time and bestlooking.skin keeps it hidden
// until then (no timezone = Australia/Perth).
//
// Site rules (projects/bestlooking.skin/CLAUDE.md): no medical claims or
// promised results, no invented facts, brand claims attributed.

const args = process.argv.slice(2);
const hasSiteFlag = args.some((arg) => arg === "--site" || arg === "-s" || arg.startsWith("--site="));

process.argv = [
  process.argv[0],
  new URL("./generate-site-post.js", import.meta.url).pathname,
  ...(hasSiteFlag ? [] : ["--site", "bestlooking.skin"]),
  ...args,
];

await import("./generate-site-post.js");
