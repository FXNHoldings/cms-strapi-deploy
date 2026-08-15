'use strict';

/*
 * Read-only, and admin-authenticated regardless. The counts describe every
 * property's content at a glance, which is not something an unauthenticated
 * caller should be able to enumerate.
 */
const guarded = (method, path, handler) => ({
  method,
  path,
  handler,
  config: { policies: ['admin::isAuthenticatedAdmin'] },
});

module.exports = {
  type: 'admin',
  routes: [guarded('GET', '/sites', 'sites.list')],
};
