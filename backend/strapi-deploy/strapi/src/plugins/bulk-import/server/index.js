'use strict';
const register = require('./src/register');
const bootstrap = require('./src/bootstrap');
const controllers = require('./src/controllers');
const routes = require('./src/routes');
const services = require('./src/services');

module.exports = {
  register,
  bootstrap,
  controllers,
  routes,
  services,
  config: { default: {}, validator() {} },
  contentTypes: {},
  policies: {},
  middlewares: {},
};
