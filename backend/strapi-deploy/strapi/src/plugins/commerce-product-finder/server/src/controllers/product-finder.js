'use strict';

module.exports = {
  async merchants(ctx) {
    ctx.body = await strapi.plugin('commerce-product-finder').service('productFinder').merchants();
  },

  async search(ctx) {
    const query = ctx.query || {};
    ctx.body = await strapi.plugin('commerce-product-finder').service('productFinder').search({
      q: query.q,
      merchantSlug: query.merchantSlug,
    });
  },

  async preview(ctx) {
    const body = ctx.request.body || {};
    if (!body.url || typeof body.url !== 'string') {
      return ctx.badRequest('Missing required field: url');
    }

    ctx.body = await strapi.plugin('commerce-product-finder').service('productFinder').previewUrl(body.url);
  },

  async save(ctx) {
    const body = ctx.request.body || {};
    if (!body.productName || typeof body.productName !== 'string') {
      return ctx.badRequest('Missing required field: productName');
    }
    if (!body.productUrl && !body.affiliateUrl) {
      return ctx.badRequest('Missing required field: productUrl or affiliateUrl');
    }

    ctx.body = await strapi.plugin('commerce-product-finder').service('productFinder').save(body);
  },

  async searchPostPrices(ctx) {
    const body = ctx.request.body || {};
    ctx.body = await strapi.plugin('commerce-product-finder').service('productFinder').searchPostPrices(body);
  },
};
