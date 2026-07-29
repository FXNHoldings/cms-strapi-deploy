'use strict';

const { startPoller } = require('./ai-images');
const { ensureCommerceProductAdminLayout } = require('./bootstrap/commerce-product-admin-layout');

const PUBLIC_BLS_READ_ACTIONS = [
  'api::gatsby-author.gatsby-author.find',
  'api::gatsby-author.gatsby-author.findOne',
  'api::gatsby-category.gatsby-category.find',
  'api::gatsby-category.gatsby-category.findOne',
  'api::gatsby-menu.gatsby-menu.find',
  'api::gatsby-menu.gatsby-menu.findOne',
  'api::gatsby-post.gatsby-post.find',
  'api::gatsby-post.gatsby-post.findOne',
  'api::gatsby-tag.gatsby-tag.find',
  'api::gatsby-tag.gatsby-tag.findOne',
  'api::bls-category.bls-category.find',
  'api::bls-category.bls-category.findOne',
  'api::bls-post.bls-post.find',
  'api::bls-post.bls-post.findOne',
  'api::nxtsmart-category.nxtsmart-category.find',
  'api::nxtsmart-category.nxtsmart-category.findOne',
  'api::nxtsmart-post.nxtsmart-post.find',
  'api::nxtsmart-post.nxtsmart-post.findOne',
  'api::nxtsmart-comment.nxtsmart-comment.find',
  'api::nxtsmart-comment.nxtsmart-comment.findOne',
  'api::nxtsmart-author.nxtsmart-author.find',
  'api::nxtsmart-author.nxtsmart-author.findOne',
  'api::commerce-deal.commerce-deal.find',
  'api::commerce-deal.commerce-deal.findOne',
  'api::commerce-brand.commerce-brand.find',
  'api::commerce-brand.commerce-brand.findOne',
  'api::commerce-category.commerce-category.find',
  'api::commerce-category.commerce-category.findOne',
  'api::commerce-merchant.commerce-merchant.find',
  'api::commerce-merchant.commerce-merchant.findOne',
  'api::commerce-offer.commerce-offer.find',
  'api::commerce-offer.commerce-offer.findOne',
  'api::commerce-price-snapshot.commerce-price-snapshot.find',
  'api::commerce-price-snapshot.commerce-price-snapshot.findOne',
  'api::commerce-product.commerce-product.find',
  'api::commerce-product.commerce-product.findOne',
  'api::commerce-site.commerce-site.find',
  'api::commerce-site.commerce-site.findOne',
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
    try {
      await ensureCommerceProductAdminLayout(strapi);
    } catch (error) {
      strapi.log.error(`[fxn-cms] Failed to configure commerce product admin layout: ${error.message}`);
    }
    startPoller(strapi);
    strapi.log.info('[fxn-cms] Bootstrap complete. AI Writer + Bulk Import plugins loaded.');
  },
};
