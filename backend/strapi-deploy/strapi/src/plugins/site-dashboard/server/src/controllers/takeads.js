'use strict';

module.exports = {
  async summary(ctx) {
    try {
      const report = await strapi
        .plugin('site-dashboard')
        .service('takeads-report')
        .summary(ctx.params.slug, {
          windowDays: ctx.query.windowDays,
        });

      if (!report) {
        ctx.status = 404;
        ctx.body = { error: `No site in the registry with slug "${ctx.params.slug}".` };
        return;
      }

      ctx.body = { report };
    } catch (error) {
      strapi.log.error(`[site-dashboard] Takeads report failed: ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: `Could not load Takeads report: ${error.message}` };
    }
  },
};
