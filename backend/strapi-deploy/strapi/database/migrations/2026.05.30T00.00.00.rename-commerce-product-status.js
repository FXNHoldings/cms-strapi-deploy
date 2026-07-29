'use strict';

/**
 * Rename the custom `status` attribute on Draft&Publish commerce content types.
 *
 * In Strapi v5, `status` is a reserved field (the document Draft/Publish state),
 * so a custom `status` attribute collides and breaks admin Publish
 * ("Invalid status"). Each affected type's attribute was renamed; this
 * migration copies existing column values into the new column (best-effort
 * fallback — the deterministic path is to RENAME the columns in Postgres
 * before deploying the new schema; see deploy notes).
 *
 * commerce-offer is intentionally NOT changed (no Draft&Publish; the frontend
 * reads its `status`).
 */
const RENAMES = [
  ['commerce_products', 'status', 'product_status'],
  ['commerce_brands', 'status', 'brand_status'],
  ['commerce_categories', 'status', 'category_status'],
  ['commerce_merchants', 'status', 'merchant_status'],
  ['commerce_deals', 'status', 'deal_status'],
  ['commerce_sites', 'status', 'site_status'],
];

module.exports = {
  async up(knex) {
    for (const [table, oldCol, newCol] of RENAMES) {
      const hasTable = await knex.schema.hasTable(table);
      if (!hasTable) continue;
      const hasOld = await knex.schema.hasColumn(table, oldCol);
      const hasNew = await knex.schema.hasColumn(table, newCol);
      if (hasOld && hasNew) {
        await knex(table).whereNotNull(oldCol).update({ [newCol]: knex.ref(oldCol) });
        await knex.schema.alterTable(table, (t) => t.dropColumn(oldCol));
      }
    }
  },

  async down() {
    // No-op: not reversing the rename automatically.
  },
};
