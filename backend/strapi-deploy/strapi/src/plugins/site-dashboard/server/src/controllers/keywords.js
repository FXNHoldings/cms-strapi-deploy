'use strict';

/**
 * Keyword research, scoped to one site.
 *
 * Two steps rather than one blocking call: DataForSEO plus a model pass takes
 * long enough that a single request would sit past the proxy's timeout. The
 * admin starts a run and then polls it.
 */
module.exports = {
  async start(ctx) {
    const svc = strapi.plugin('site-dashboard').service('keyword-research');
    const body = ctx.request.body || {};
    const out = await svc.research(ctx.params.slug, {
      seed: body.seed,
      count: body.count,
      longtail: body.longtail,
      location: body.location,
    });
    if (out.error) return ctx.badRequest(out.error);
    ctx.body = out;
  },

  async result(ctx) {
    const svc = strapi.plugin('site-dashboard').service('keyword-research');
    ctx.body = await svc.result(ctx.params.runId);
  },
};
