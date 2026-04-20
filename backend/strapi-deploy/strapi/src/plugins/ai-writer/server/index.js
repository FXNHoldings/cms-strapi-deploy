'use strict';
const register = require('./src/register');
const bootstrap = require('./src/bootstrap');
const destroy = require('./src/destroy');
const config = require('./src/config');
const contentTypes = require('./src/content-types');
const controllers = require('./src/controllers');
const routes = require('./src/routes');
const services = require('./src/services');
const policies = require('./src/policies');
const middlewares = require('./src/middlewares');

module.exports = {
  register,
  bootstrap,
  destroy,
  config,
  controllers,
  routes,
  services,
  contentTypes,
  policies,
  middlewares,
};
