/* eslint-disable no-console */
'use strict';

/**
 * Hide products that have no usable buy link.
 *
 *   node ./scripts/unpublish-offerless-products.mjs --dry-run
 *   node ./scripts/unpublish-offerless-products.mjs
 *   node ./scripts/unpublish-offerless-products.mjs --republish
 *
 * A product with no offer, or whose every offer points at a retailer's search
 * page, cannot be bought. It renders a page with a Buy button that goes
 * nowhere, or to a list of search results. Hiding it costs nothing and stops
 * the site advertising something it cannot sell.
 *
 * Unpublished, never deleted. The draft keeps every field — description,
 * specifications, images, all of which cost money to source — so republishing
 * is one call once a real offer exists. --republish reverses the whole run.
 *
 * WHY THIS IS A SCRIPT AND NOT AN API CALL. Strapi 5's REST API has no
 * unpublish. Established the hard way:
 *
 *   DELETE /api/commerce-products/:id?status=published   deletes the WHOLE
 *       document, draft included. This destroyed a real product.
 *   PUT with publishedAt: null                           returns 200 and does
 *       not unpublish; the published row is replaced, not removed.
 *   POST .../actions/unpublish                           405, does not exist.
 *
 * The Document Service does have unpublish(), with the semantics we actually
 * want, so this runs inside the app rather than against its HTTP surface.
 */

import { createRequire } from 'module';

// Before the app loads: bootstrap reads this to skip the AI-image poller, which
// otherwise competes with the script for the connection pool.
process.env.STRAPI_SKIP_POLLERS = '1';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

const PRODUCT_UID = 'api::commerce-product.commerce-product';
const OFFER_UID = 'api::commerce-offer.commerce-offer';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REPUBLISH = args.includes('--republish');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) ?? '').split('=')[1] || Infinity);

/* Kept in step with scripts/lib/search-url.mjs in nxt-sourcing. Duplicated
   because that lives in a different project which is not on this image. */
const SEARCH_PATHS = /(^|\/)(s|search|catalogsearch|find|results|browse|sq)(\/|$)/i;
const SEARCH_PARAMS = new Set([
  'q', 'query', 's', 'k', 'keyword', 'keywords',
  'searchterm', 'search_term', 'search', 'term', 'text', 'st', 'w',
]);

function isSearchUrl(url) {
  try {
    const u = new URL(url);
    if (SEARCH_PATHS.test(u.pathname)) return true;
    for (const key of u.searchParams.keys()) {
      if (SEARCH_PARAMS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function main() {
  const strapi = await createStrapi().load();
  strapi.log.level = 'error';

  try {
    if (REPUBLISH) {
      const hidden = await strapi.documents(PRODUCT_UID).findMany({
        status: 'draft',
        filters: { publishedAt: { $null: true } },
        fields: ['name', 'slug'],
        limit: 1000,
      });
      console.log(`${hidden.length} unpublished product(s) found`);
      for (const p of hidden) {
        console.log(`  republish  ${p.slug}`);
        if (!DRY_RUN) await strapi.documents(PRODUCT_UID).publish({ documentId: p.documentId });
      }
      console.log(`\n${DRY_RUN ? 'Dry run. ' : ''}${hidden.length} republished.`);
      return;
    }

    const products = await strapi.documents(PRODUCT_UID).findMany({
      status: 'published',
      fields: ['name', 'slug'],
      limit: 5000,
    });

    console.log(`${products.length} published product(s) to examine\n`);

    const doomed = [];
    for (const product of products) {
      const offers = await strapi.documents(OFFER_UID).findMany({
        filters: { product: { documentId: product.documentId } },
        fields: ['productUrl'],
        limit: 100,
      });

      const usable = offers.filter((o) => o.productUrl && !isSearchUrl(o.productUrl));
      if (usable.length > 0) continue;

      doomed.push({ ...product, offers: offers.length });
    }

    const selected = LIMIT === Infinity ? doomed : doomed.slice(0, LIMIT);
    console.log(`${doomed.length} product(s) have no usable buy link · ${selected.length} selected · ${DRY_RUN ? 'DRY RUN' : 'UNPUBLISHING'}\n`);

    for (const p of selected) {
      console.log(`  hide  ${String(p.offers).padStart(2)} dead offer(s)  ${p.slug}`);
      if (!DRY_RUN) await strapi.documents(PRODUCT_UID).unpublish({ documentId: p.documentId });
    }

    console.log(`\n${DRY_RUN ? 'Dry run. Nothing changed. ' : ''}${DRY_RUN ? 0 : selected.length} unpublished.`);
    if (!DRY_RUN) console.log('Drafts are intact — run with --republish to reverse.');
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
