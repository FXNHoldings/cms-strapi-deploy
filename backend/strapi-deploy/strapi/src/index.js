'use strict';

module.exports = {
  register() {},
  async bootstrap({ strapi }) {
    strapi.log.info('[fxn-cms] Bootstrap complete. AI Writer + Bulk Import plugins loaded.');
  },
};
