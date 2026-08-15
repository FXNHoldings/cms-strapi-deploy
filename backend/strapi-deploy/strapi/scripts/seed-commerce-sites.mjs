/* eslint-disable no-console */
'use strict';

/**
 * Seeds the site registry — one commerce-site row per property we publish.
 *
 * The registry is what the dashboard reads to answer "which collections belong
 * to this site", so the interesting field is `contentTypes`. Everything else is
 * reference material recorded in one place instead of six.
 *
 * Idempotent by domain. Existing rows are only filled where a field is empty,
 * so a value someone set in the admin survives a re-run; pass --force to
 * overwrite them from this file instead. Nothing is ever deleted.
 *
 *   node ./scripts/seed-commerce-sites.mjs --dry-run
 *   node ./scripts/seed-commerce-sites.mjs
 *   node ./scripts/seed-commerce-sites.mjs --force
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

const UID = 'api::commerce-site.commerce-site';

/**
 * `contentTypes` roles are arrays because a role can have more than one source.
 * nxtsmarthome.com.au is the case that forces it: its markdown-sourced posts
 * live in nxtsmarthome-post, but it also shares nxtsmart-post with
 * nxtsmart.homes, split by that type's own `site` enum. Counting one without
 * the other under-reports the site; counting nxtsmart-post without the filter
 * over-reports it with the other site's rows.
 */
const SITES = [
  {
    name: 'Originfacts',
    domain: 'originfacts.com',
    niche: 'Travel',
    currency: 'USD',
    gaMeasurementId: 'G-TY066MKR0Z',
    repoPath: '/opt/projects/originfacts.com',
    deployCommand: 'manual build + restart on the host',
    contentTypes: {
      posts: [{ uid: 'api::article.article' }],
      categories: [{ uid: 'api::category.category' }],
      authors: [{ uid: 'api::author.author' }],
      tags: [{ uid: 'api::tag.tag' }],
    },
  },
  {
    name: 'BestLooking.Skin',
    domain: 'bestlooking.skin',
    niche: 'Skincare',
    gaMeasurementId: 'G-89P8C28LJ4',
    repoPath: '/opt/projects/bestlooking.skin',
    deployCommand: './deploy.sh',
    contentTypes: {
      posts: [{ uid: 'api::bls-post.bls-post' }],
      categories: [{ uid: 'api::bls-category.bls-category' }],
    },
  },
  {
    name: 'NXT.Bargains',
    domain: 'nxt.bargains',
    niche: 'Deals & commerce',
    gaMeasurementId: 'G-SY905B67WX',
    repoPath: '/opt/projects/nxt.bargains',
    deployCommand: './deploy.sh',
    contentTypes: {
      posts: [{ uid: 'api::nxt-post.nxt-post' }],
      categories: [{ uid: 'api::nxt-category.nxt-category' }],
      authors: [{ uid: 'api::nxt-author.nxt-author' }],
      comments: [{ uid: 'api::nxt-comment.nxt-comment' }],
    },
  },
  {
    name: 'NXTSmart.Homes',
    domain: 'nxtsmart.homes',
    niche: 'Smart home',
    gaMeasurementId: 'G-KTD0TX1LFX',
    repoPath: '/opt/projects/nxtsmart.homes',
    deployCommand: './deploy.sh',
    contentTypes: {
      posts: [{ uid: 'api::nxtsmart-post.nxtsmart-post', filter: { site: 'nxtsmart.homes' } }],
      categories: [{ uid: 'api::nxtsmart-category.nxtsmart-category' }],
      authors: [{ uid: 'api::nxtsmart-author.nxtsmart-author' }],
      comments: [{ uid: 'api::nxtsmart-comment.nxtsmart-comment' }],
      menus: [{ uid: 'api::nxtsmart-menu.nxtsmart-menu' }],
    },
  },
  {
    name: 'NXT Smart Home AU',
    domain: 'nxtsmarthome.com.au',
    niche: 'Smart home',
    country: 'AU',
    currency: 'AUD',
    gaMeasurementId: 'G-SY9XCRZH2K',
    repoPath: '/opt/projects/nxtsmarthome.com.au',
    deployCommand: 'git push master (Cloudflare Pages)',
    contentTypes: {
      posts: [
        { uid: 'api::nxtsmarthome-post.nxtsmarthome-post' },
        { uid: 'api::nxtsmart-post.nxtsmart-post', filter: { site: 'nxtsmarthome.com.au' } },
      ],
      categories: [{ uid: 'api::nxtsmarthome-category.nxtsmarthome-category' }],
    },
  },
  {
    name: 'FXN SEO',
    domain: 'fxnseo.com',
    niche: 'SEO',
    deployCommand: 'sync-fxnseo job on the runner (SSH push)',
    contentTypes: {
      posts: [{ uid: 'api::fxnseo-post.fxnseo-post' }],
    },
  },
];

function parseArgs() {
  const out = { dryRun: false, force: false, help: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      out.help = true;
    }
  }
  return out;
}

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function slugify(domain) {
  return domain.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

/** Fields this script owns. `name` and `slug` are deliberately not among them —
 *  renaming a site is an editorial decision, not something a re-run should undo. */
const MANAGED = [
  'niche',
  'country',
  'currency',
  'gaMeasurementId',
  'repoPath',
  'deployCommand',
  'contentTypes',
  'affiliateTags',
];

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node ./scripts/seed-commerce-sites.mjs [--dry-run] [--force]');
    process.exit(0);
  }

  const strapi = await createStrapi().load();
  strapi.log.level = 'error';

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  try {
    for (const site of SITES) {
      const existing = await strapi.documents(UID).findFirst({
        filters: { domain: site.domain },
        status: 'draft',
      });

      if (!existing) {
        const data = { ...site, slug: slugify(site.domain), siteStatus: 'active' };
        console.log(`create  ${site.domain}  (${Object.keys(site.contentTypes).length} content roles)`);
        if (!args.dryRun) {
          const doc = await strapi.documents(UID).create({ data });
          await strapi.documents(UID).publish({ documentId: doc.documentId });
        }
        created += 1;
        continue;
      }

      const patch = {};
      for (const field of MANAGED) {
        if (site[field] === undefined) continue;
        if (args.force || isEmpty(existing[field])) patch[field] = site[field];
      }
      // siteStatus is required by the schema but null on rows that predate it.
      if (isEmpty(existing.siteStatus)) patch.siteStatus = 'active';

      if (Object.keys(patch).length === 0) {
        console.log(`ok      ${site.domain}`);
        unchanged += 1;
        continue;
      }

      console.log(`update  ${site.domain}  ${Object.keys(patch).join(', ')}`);
      if (!args.dryRun) {
        await strapi.documents(UID).update({ documentId: existing.documentId, data: patch });
        await strapi.documents(UID).publish({ documentId: existing.documentId });
      }
      updated += 1;
    }

    console.log(
      `\n${args.dryRun ? 'Dry run. ' : ''}${created} created, ${updated} updated, ${unchanged} already correct.`,
    );
  } finally {
    await strapi.destroy();
  }
}

// Exit explicitly rather than waiting for a quiet event loop. The app's
// bootstrap starts the AI-image poller, and its interval outlives
// strapi.destroy() — once the pool is closed it fails to acquire a connection
// every five seconds forever, so the script would hang after printing its
// summary. A one-off script has nothing left to do by this point.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
