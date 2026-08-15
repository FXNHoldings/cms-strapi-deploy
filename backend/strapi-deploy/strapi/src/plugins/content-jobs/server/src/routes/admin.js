'use strict';

/*
 * Everything is admin-authenticated. These endpoints start jobs that spend
 * money and write to the catalogue, so none of them may be reachable by an
 * unauthenticated caller.
 */
const guarded = (method, path, handler) => ({
  method, path, handler,
  config: { policies: ['admin::isAuthenticatedAdmin'] },
});

module.exports = {
  type: 'admin',
  routes: [
    guarded('GET', '/jobs', 'jobs.catalogue'),
    guarded('GET', '/runs', 'jobs.history'),
    guarded('POST', '/runs', 'jobs.start'),
    guarded('GET', '/runs/:id', 'jobs.detail'),
    guarded('GET', '/runs/:id/log', 'jobs.log'),
    guarded('POST', '/runs/:id/cancel', 'jobs.cancel'),
  ],
};
