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
};
