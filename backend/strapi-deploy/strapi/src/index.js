'use strict';

const { startPoller } = require('./ai-images');

const PUBLIC_BLS_READ_ACTIONS = [
  'api::bls-category.bls-category.find',
  'api::bls-category.bls-category.findOne',
  'api::bls-post.bls-post.find',
  'api::bls-post.bls-post.findOne',
  'api::bls-product.bls-product.find',
  'api::bls-product.bls-product.findOne',
  'api::bls-product-category.bls-product-category.find',
  'api::bls-product-category.bls-product-category.findOne',
  'api::bls-product-brand.bls-product-brand.find',
  'api::bls-product-brand.bls-product-brand.findOne',
];

function documentId() {
  return Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
}

async function ensurePublicBlsReadPermissions(strapi) {
  const knex = strapi.db.connection;
  const publicRole = await knex('up_roles').where({ type: 'public' }).first('id');
  if (!publicRole?.id) {
    strapi.log.warn('[fxn-cms] Public role not found; skipped BLS public permission bootstrap.');
    return;
  }

  for (const action of PUBLIC_BLS_READ_ACTIONS) {
    let permission = await knex('up_permissions').where({ action }).first('id');
    if (!permission?.id) {
      const [created] = await knex('up_permissions')
        .insert({
          document_id: documentId(),
          action,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
          published_at: knex.fn.now(),
        })
        .returning('id');
      permission = typeof created === 'object' ? created : { id: created };
    }

    const existingLink = await knex('up_permissions_role_lnk')
      .where({ permission_id: permission.id, role_id: publicRole.id })
      .first('id');

    if (!existingLink) {
      await knex('up_permissions_role_lnk').insert({
        permission_id: permission.id,
        role_id: publicRole.id,
        permission_ord: 0,
      });
    }
  }

  strapi.log.info('[fxn-cms] BLS public read permissions verified.');
}

module.exports = {
  register() {},
  async bootstrap({ strapi }) {
    try {
      await ensurePublicBlsReadPermissions(strapi);
    } catch (error) {
      strapi.log.error(`[fxn-cms] Failed to verify BLS public read permissions: ${error.message}`);
    }
    startPoller(strapi);
    strapi.log.info('[fxn-cms] Bootstrap complete. AI Writer + Bulk Import plugins loaded.');
  },
};
