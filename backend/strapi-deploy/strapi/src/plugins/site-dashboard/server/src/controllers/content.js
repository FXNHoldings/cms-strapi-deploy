'use strict';

/**
 * List and publish-toggle for one role of one site.
 *
 * Both delegate the registry lookup to the service, which is what refuses a
 * uid the site does not claim — the controller never trusts ctx.params.uid.
 */

const svc = () => strapi.plugin('site-dashboard').service('content-list');

module.exports = {
  async list(ctx) {
    const { slug, role } = ctx.params;
    const { page, pageSize, q } = ctx.query;
    try {
      const result = await svc().list(slug, role, { page, pageSize, q });
      if (result.error) {
        ctx.status = 404;
        ctx.body = { error: result.error };
        return;
      }
      ctx.body = result;
    } catch (error) {
      strapi.log.error(`[site-dashboard] list ${slug}/${role}: ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: `Could not list ${role}: ${error.message}` };
    }
  },

  async publish(ctx) {
    const { slug, role } = ctx.params;
    const { uid, documentId, published } = ctx.request.body ?? {};

    if (!uid || !documentId || typeof published !== 'boolean') {
      ctx.status = 400;
      ctx.body = { error: 'uid, documentId and a boolean published are all required.' };
      return;
    }

    try {
      const result = await svc().setPublished(slug, role, uid, documentId, published);
      if (result.error) {
        ctx.status = 400;
        ctx.body = { error: result.error };
        return;
      }
      ctx.body = result;
    } catch (error) {
      strapi.log.error(`[site-dashboard] publish ${uid}/${documentId}: ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: `Could not change publish state: ${error.message}` };
    }
  },
};
