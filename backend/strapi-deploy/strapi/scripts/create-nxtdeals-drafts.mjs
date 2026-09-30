/* eslint-disable no-console */
'use strict';

/**
 * Create nxt.deals editorial drafts from a brief manifest, and keep them drafts.
 *
 *   docker cp <site>/content/post-briefs.json strapi-cms:/tmp/post-briefs.json
 *   docker compose exec strapi node scripts/create-nxtdeals-drafts.mjs --from /tmp/post-briefs.json [--dry-run]
 *
 * This runs inside the container on purpose. The REST API publishes on create,
 * so a draft cannot be made over HTTP; the Document Service can create without
 * publishing and can unpublish, which is what a commissioning queue needs.
 *
 * Idempotent by slug. A post that already exists is left alone except for one
 * correction: if it is published and was created from this manifest, it is
 * unpublished, because these are commissions rather than articles.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'module';

process.env.STRAPI_SKIP_POLLERS = '1';
const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fromIdx = args.indexOf('--from');
const MANIFEST = fromIdx !== -1 ? args[fromIdx + 1] : '/tmp/post-briefs.json';
const onlyCategory = (args.find((a) => a.startsWith('--category=')) || '').split('=')[1] || null;
if (!existsSync(MANIFEST)) {
  console.error(`No manifest at ${MANIFEST}. Copy content/post-briefs.json into the container first.`);
  process.exit(1);
}

const POST = 'api::nxtdeals-post.nxtdeals-post';
const CATEGORY = 'api::nxtdeals-category.nxtdeals-category';
const AUTHOR = 'api::nxtdeals-author.nxtdeals-author';

const slugify = (s) => String(s).toLowerCase().normalize('NFKD')
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110).replace(/-+$/g, '');

/** The brief an editor opens the draft to find. */
function brief(p) {
  const lines = [
    '> **Draft brief — not for publication.** This is the commission, not the article.',
    '> Replace this content entirely when the piece is written.',
    '',
    '## The angle',
    '',
    p.angle,
    '',
    '## Structure',
    '',
    '1. Answer the title in the first 40–60 words, directly under the H1.',
    '2. Question-phrased H2s that mirror what people actually search.',
    `3. One comparison table: ${p.table}.`,
    `4. One numbered list: ${p.list}.`,
    '5. Three to five FAQs at the end.',
    `6. Link to two or three store or category pages${p.link ? ` and to [this related guide](${p.link})` : ' and one related guide'}.`,
    '',
    '## Verify before publishing',
    '',
    ...p.verify.map((v) => `- [ ] ${v}`),
    '',
    '_Cite the primary source for each. Anything that cannot be verified is left out, not estimated._',
  ];
  if (p.gate) lines.push('', '## Gate', '', `**${p.gate}**`);
  return lines.join('\n');
}

async function main() {
  const strapi = await createStrapi().load();
  strapi.log.level = 'error';
  const posts = JSON.parse(readFileSync(MANIFEST, 'utf8')).posts.filter((p) => !onlyCategory || p.category === onlyCategory);

  let created = 0; let unpublished = 0; let untouched = 0; let missingCat = 0;
  try {
    const cats = await strapi.documents(CATEGORY).findMany({ fields: ['slug'], limit: 200 });
    const catId = new Map(cats.map((c) => [c.slug, c.documentId]));
    const authors = await strapi.documents(AUTHOR).findMany({ fields: ['slug'], limit: 20, status: 'draft' });
    const authorId = authors[0]?.documentId ?? null;

    for (const p of posts) {
      const slug = slugify(p.title);
      const existing = await strapi.documents(POST).findFirst({ filters: { slug }, status: 'draft' });
      // The draft version always has publishedAt null, so it cannot tell you
      // whether the document is live. Ask for the published version instead.
      const live = existing ? await strapi.documents(POST).findFirst({ filters: { slug }, status: 'published' }) : null;

      if (existing) {
        // Correct a post that was published by mistake; leave its content alone.
        if (live) {
          console.log(`unpublish ${p.category.padEnd(19)} ${slug}`);
          if (!dryRun) await strapi.documents(POST).unpublish({ documentId: existing.documentId });
          unpublished += 1;
        } else {
          untouched += 1;
        }
        continue;
      }

      if (!catId.has(p.category)) { console.log(`NO CAT    ${p.category.padEnd(19)} ${slug}`); missingCat += 1; continue; }
      const content = brief(p);
      console.log(`draft     ${p.category.padEnd(19)} ${slug}`);
      if (dryRun) { created += 1; continue; }

      // create() without publish() leaves the document in draft, which is the point.
      await strapi.documents(POST).create({
        data: {
          title: p.title,
          slug,
          excerpt: p.excerpt,
          content,
          postType: p.postType || 'explainer',
          featured: false,
          readingTimeMinutes: Math.max(1, Math.round(content.split(/\s+/).length / 220)),
          seoDescription: p.excerpt.slice(0, 157).replace(/\s+\S*$/, ''),
          source: 'manual',
          ...(authorId ? { author: authorId } : {}),
          categories: [catId.get(p.category)],
        },
      });
      created += 1;
    }

    console.log(`\n${dryRun ? 'Dry run. ' : ''}${created} draft(s) created, ${unpublished} unpublished, ${untouched} already draft${missingCat ? `, ${missingCat} unknown category` : ''}.`);
    console.log('Nothing here is published. These are commissions; an editor publishes the article that replaces the brief.');
  } finally {
    await strapi.destroy();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
