/* eslint-disable no-console */
'use strict';

/**
 * Import legacy WordPress comments (wp.nxtsmart.homes) into the
 * api::nxtsmart-comment collection.
 *
 * For every nxtsmart-post with a legacyWpId, fetches that WP post's comments
 * via the public REST API and upserts them keyed on the comment's WP id
 * (legacyWpId) — safe to re-run. Threading (parent/replies) is preserved.
 *
 * Usage (inside the strapi container / app root):
 *   node scripts/import-nxtsmart-wp-comments.mjs [--dry-run]
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

process.on('uncaughtException', (error) => {
  if (error?.message === 'aborted') process.exit(0);
  throw error;
});

const WP_BASE = 'https://wp.nxtsmart.homes';
const POST_UID = 'api::nxtsmart-post.nxtsmart-post';
const COMMENT_UID = 'api::nxtsmart-comment.nxtsmart-comment';
const DRY_RUN = process.argv.includes('--dry-run');

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

function toPlainText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<\/p>\s*<p>/g, '\n\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

async function fetchWpComments(wpPostId) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${WP_BASE}/wp-json/wp/v2/comments?post=${wpPostId}&per_page=100&page=${page}&orderby=date&order=asc`;
    // Cloudflare 503s non-browser user agents (e.g. node/wget) on this host.
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fxn-cms-import)' } });
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function listPostsWithLegacyId(strapi) {
  const posts = [];
  const pageSize = 100;
  for (let start = 0; ; start += pageSize) {
    const batch = await strapi.documents(POST_UID).findMany({
      filters: { legacyWpId: { $notNull: true } },
      fields: ['legacyWpId', 'slug', 'title'],
      sort: ['id:asc'],
      limit: pageSize,
      start,
    });
    posts.push(...batch);
    if (batch.length < pageSize) break;
  }
  return posts;
}

async function findExisting(strapi, wpCommentId) {
  const rows = await strapi.documents(COMMENT_UID).findMany({
    filters: { legacyWpId: { $eq: wpCommentId } },
    limit: 1,
  });
  return rows[0] ?? null;
}

async function main() {
  const strapi = await createStrapi().load();
  const stats = { posts: 0, comments: 0, created: 0, skipped: 0, orphanParents: 0 };

  try {
    const posts = await listPostsWithLegacyId(strapi);
    console.log(`Found ${posts.length} posts with legacyWpId.`);

    for (const post of posts) {
      const wpComments = await fetchWpComments(post.legacyWpId);
      if (wpComments.length === 0) continue;
      stats.posts += 1;
      stats.comments += wpComments.length;

      // Parents before children so replies can link to their parent's documentId.
      const ordered = [...wpComments].sort((a, b) => (a.parent || 0) - (b.parent || 0) || a.id - b.id);
      const docIdByWpId = new Map();

      for (const c of ordered) {
        const body = toPlainText(c.content?.rendered);
        if (!body) { stats.skipped += 1; continue; }

        const existing = await findExisting(strapi, c.id);
        if (existing) {
          docIdByWpId.set(c.id, existing.documentId);
          stats.skipped += 1;
          continue;
        }

        let parentDocId = null;
        if (c.parent) {
          parentDocId = docIdByWpId.get(c.parent) ?? (await findExisting(strapi, c.parent))?.documentId ?? null;
          if (!parentDocId) stats.orphanParents += 1;
        }

        const data = {
          post: post.documentId,
          authorName: decodeEntities(c.author_name || 'Anonymous').slice(0, 80),
          body: body.slice(0, 4000),
          commentStatus: 'approved',
          postedAt: c.date_gmt ? `${c.date_gmt}Z` : c.date,
          legacyWpId: c.id,
          source: 'wp-import',
          ...(parentDocId ? { parent: parentDocId } : {}),
        };

        if (DRY_RUN) {
          console.log(`[dry-run] would create comment wp#${c.id} on "${post.slug}" by ${data.authorName}`);
          stats.created += 1;
          continue;
        }

        const createdDoc = await strapi.documents(COMMENT_UID).create({ data });
        docIdByWpId.set(c.id, createdDoc.documentId);
        stats.created += 1;
      }
      console.log(`${post.slug}: ${wpComments.length} WP comments processed.`);
    }
  } finally {
    console.log(JSON.stringify({ dryRun: DRY_RUN, ...stats }, null, 2));
    await strapi.destroy().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
