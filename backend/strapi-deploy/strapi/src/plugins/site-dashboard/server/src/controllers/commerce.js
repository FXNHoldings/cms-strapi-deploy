'use strict';

/** Catalogue listings for one site. Read-only; publishing goes through content.publish. */
const svc = () => strapi.plugin('site-dashboard').service('commerce-list');

module.exports = {
  async counts(ctx) {
    try {
      ctx.body = { counts: await svc().counts(ctx.params.slug) };
    } catch (error) {
      strapi.log.error(`[site-dashboard] commerce counts: ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  },

  async list(ctx) {
    const { slug, role } = ctx.params;
    const { page, pageSize, q, tab } = ctx.query;
    try {
      const result = await svc().list(slug, role, { page, pageSize, q, tab });
      if (result.error) {
        ctx.status = 400;
        ctx.body = { error: result.error };
        return;
      }
      ctx.body = result;
    } catch (error) {
      strapi.log.error(`[site-dashboard] commerce list ${slug}/${role}: ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: `Could not list ${role}: ${error.message}` };
    }
  },

  async publish(ctx) {
    const { slug, role } = ctx.params;
    const { documentId, published } = ctx.request.body ?? {};
    if (!documentId || typeof published !== 'boolean') {
      ctx.status = 400;
      ctx.body = { error: 'documentId and a boolean published are both required.' };
      return;
    }
    try {
      const result = await svc().setPublished(slug, role, documentId, published);
      if (result.error) { ctx.status = 400; ctx.body = { error: result.error }; return; }
      ctx.body = result;
    } catch (error) {
      strapi.log.error(`[site-dashboard] commerce publish: ${error.stack || error.message}`);
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  },
};
