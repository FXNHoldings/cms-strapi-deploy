'use strict';

const { startPoller } = require('./ai-images');

module.exports = {
  register() {},
  async bootstrap({ strapi }) {
    startPoller(strapi);
    strapi.log.info('[fxn-cms] Bootstrap complete. AI Writer + Bulk Import plugins loaded.');
  },
};
