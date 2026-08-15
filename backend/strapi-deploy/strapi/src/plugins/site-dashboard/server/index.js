'use strict';
const controllers = require('./src/controllers');
const routes = require('./src/routes');
const services = require('./src/services');

module.exports = {
  register() {},
  bootstrap() {},
  destroy() {},
  config: { default: {} },
  controllers,
  routes,
  contentTypes: {},
  services,
  policies: {},
  middlewares: {},
};
