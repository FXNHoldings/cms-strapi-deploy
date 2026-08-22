'use strict';

module.exports = {
  async list(ctx) {
    try {
      const sites = await strapi
        .plugin('site-dashboard')
        .service('site-stats')
        .list();
      ctx.body = { sites };
    } catch (error) {
      strapi.log.error(`[site-dashboard] ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: `Could not read the site registry: ${error.message}` };
    }
  },

  async detail(ctx) {
    try {
      const site = await strapi
        .plugin('site-dashboard')
        .service('site-stats')
        .detail(ctx.params.slug);

      if (!site) {
        ctx.status = 404;
        ctx.body = { error: `No site in the registry with slug "${ctx.params.slug}".` };
        return;
      }

      ctx.body = { site };
    } catch (error) {
      strapi.log.error(`[site-dashboard] ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: `Could not read that site: ${error.message}` };
    }
  },
};
