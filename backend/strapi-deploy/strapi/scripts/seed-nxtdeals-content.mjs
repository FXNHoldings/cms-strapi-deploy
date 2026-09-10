/* eslint-disable no-console */
'use strict';

/**
 * Seeds nxt.deals launch content (categories, stores, authors, FAQs, guides)
 * straight through the Document Service, so it runs inside the container with
 * no API token:
 *
 *   docker cp /opt/projects/nxt.deals/content/seed strapi-cms:/tmp/nxtdeals-seed
 *   docker compose exec strapi node scripts/seed-nxtdeals-content.mjs --from /tmp/nxtdeals-seed [--dry-run]
 *
 * The seed directory is the one shipped in the site repo (content/seed).
 * Idempotent by slug: existing documents are updated, missing ones created,
 * everything published. Nothing is deleted. Deals are deliberately not seeded.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'module';

process.env.STRAPI_SKIP_POLLERS = '1';
const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fromIdx = args.indexOf('--from');
const SEED = fromIdx !== -1 ? args[fromIdx + 1] : '/tmp/nxtdeals-seed';
if (!existsSync(join(SEED, 'categories.json'))) {
  console.error(`No seed at ${SEED} (expected categories.json). Pass --from <dir>.`);
  process.exit(1);
}

const json = (f) => JSON.parse(readFileSync(join(SEED, f), 'utf8'));
const strip = ({ id, ...rest }) => rest;

function parseFrontMatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i !== -1) data[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { data, body: m[2].trim() };
}

async function main() {
  const strapi = await createStrapi().load();
  strapi.log.level = 'error';
  let created = 0;
  let updated = 0;

  async function upsert(uid, slug, data) {
    const existing = await strapi.documents(uid).findFirst({ filters: { slug }, status: 'draft' });
    console.log(`${existing ? 'update' : 'create'}  ${uid.split('.')[1]}/${slug}`);
    if (dryRun) return existing?.documentId || null;
    let doc;
    if (existing) {
      doc = await strapi.documents(uid).update({ documentId: existing.documentId, data });
      updated += 1;
    } else {
      doc = await strapi.documents(uid).create({ data });
      created += 1;
    }
    // Types without draftAndPublish (categories) have no publish step.
    if (strapi.contentTypes[uid]?.options?.draftAndPublish) {
      await strapi.documents(uid).publish({ documentId: doc.documentId });
    }
    return doc.documentId;
  }

  try {
    const categoryIds = {};
    const cats = json('categories.json');
    for (const c of cats) {
      const { parent, ...data } = strip(c);
      categoryIds[c.slug] = await upsert('api::nxtdeals-category.nxtdeals-category', c.slug, data);
    }
    // Second pass: parent links by slug (a child may be listed before its parent).
    for (const c of cats) {
      if (!c.parent || !categoryIds[c.parent] || !categoryIds[c.slug] || dryRun) continue;
      await strapi.documents('api::nxtdeals-category.nxtdeals-category').update({ documentId: categoryIds[c.slug], data: { parent: categoryIds[c.parent] } });
    }
    for (const s of json('stores.json')) await upsert('api::nxtdeals-store.nxtdeals-store', s.slug, strip(s));
    const authorIds = {};
    for (const a of json('authors.json')) authorIds[a.slug] = await upsert('api::nxtdeals-author.nxtdeals-author', a.slug, strip(a));
    for (const f of json('faqs.json')) await upsert('api::nxtdeals-faq.nxtdeals-faq', f.slug, strip(f));

    const guides = join(SEED, 'guides');
    for (const file of existsSync(guides) ? readdirSync(guides).filter((f) => f.endsWith('.md')) : []) {
      const { data, body } = parseFrontMatter(readFileSync(join(guides, file), 'utf8'));
      const slug = data.slug || file.replace(/\.md$/, '');
      const cats = (data.categories || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => categoryIds[s]).filter(Boolean);
      await upsert('api::nxtdeals-post.nxtdeals-post', slug, {
        title: data.title,
        slug,
        excerpt: data.excerpt || null,
        content: body,
        postType: data.postType || 'buying-guide',
        featured: data.featured === 'true',
        readingTimeMinutes: Math.max(1, Math.round(body.split(/\s+/).length / 220)),
        seoDescription: data.seoDescription || data.excerpt || null,
        source: 'seed',
        ...(authorIds[data.author] ? { author: authorIds[data.author] } : {}),
        ...(cats.length ? { categories: cats } : {}),
        publishedAt: data.publishedAt || new Date().toISOString(),
      });
    }
    console.log(`\n${dryRun ? 'Dry run. ' : ''}${created} created, ${updated} updated.`);
  } finally {
    await strapi.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
