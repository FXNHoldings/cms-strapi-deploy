'use strict';

/**
 * Fills in what the redirect cannot know.
 *
 * The /go handler on each site knows its own slug and the merchant it is
 * sending someone to. It does not know this CMS's document ids, and should not
 * have to — so the slug becomes the `site` relation here, and the merchant's
 * EPC becomes an estimated value at click time.
 *
 * The estimate is stamped on the row rather than computed later on purpose: EPC
 * changes, and a click should keep the value it was worth when it happened.
 *
 * Neither step is allowed to fail the write. A click that lands without a site
 * relation is still a click; one lost to a lookup error is gone for good.
 */

async function linkSite(data, strapi) {
  if (data.site || !data.siteSlug) return;

  const [site] = await strapi.documents('api::commerce-site.commerce-site').findMany({
    filters: { slug: data.siteSlug },
    status: 'draft',
    limit: 1,
  });

  if (site) data.site = site.documentId;
}

async function stampEstimatedValue(data, strapi) {
  if (data.estimatedValue != null || !data.merchant) return;

  const needle = String(data.merchant).toLowerCase();
  const [merchant] = await strapi.documents('api::commerce-merchant.commerce-merchant').findMany({
    filters: { $or: [{ slug: needle }, { name: { $eqi: needle } }] },
    status: 'published',
    limit: 1,
  });

  if (merchant?.epc != null) {
    data.estimatedValue = merchant.epc;
    data.currency = merchant.epcCurrency || data.currency || 'USD';
  }
}

module.exports = {
  async beforeCreate(event) {
    const { data } = event.params;
    try {
      await linkSite(data, strapi);
    } catch (error) {
      strapi.log.warn(`[affiliate-click] could not link site "${data.siteSlug}": ${error.message}`);
    }
    try {
      await stampEstimatedValue(data, strapi);
    } catch (error) {
      strapi.log.warn(`[affiliate-click] could not price click: ${error.message}`);
    }
  },
};
