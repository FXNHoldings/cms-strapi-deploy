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
  routes: [
    guarded('GET', '/sites', 'sites.list'),
    guarded('GET', '/sites/:slug', 'sites.detail'),
    guarded('GET', '/sites/:slug/content/:role', 'content.list'),
    // The only write this plugin has. Reversible on purpose — see content-list.js.
    guarded('PUT', '/sites/:slug/content/:role/publish', 'content.publish'),
    /* Paid: each run bills DataForSEO, so it is a POST a person triggers. */
    guarded('POST', '/sites/:slug/keywords', 'keywords.start'),
    guarded('GET', '/sites/:slug/keywords/:runId', 'keywords.result'),
    guarded('GET', '/sites/:slug/commerce', 'commerce.counts'),
    guarded('GET', '/sites/:slug/commerce/:role', 'commerce.list'),
    guarded('PUT', '/sites/:slug/commerce/:role/publish', 'commerce.publish'),
  ],
};
