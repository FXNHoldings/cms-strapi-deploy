'use strict';

const controllers = require('./src/controllers');
const routes = require('./src/routes');
const services = require('./src/services');

module.exports = {
  register() {},
  bootstrap({ strapi }) {
    strapi.log.info('[commerce-product-finder] bootstrapped');
  },
  controllers,
  routes,
  services,
};
