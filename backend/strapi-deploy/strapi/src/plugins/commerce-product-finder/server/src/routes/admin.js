'use strict';

const adminOnly = { policies: ['admin::isAuthenticatedAdmin'] };

module.exports = {
  type: 'admin',
  routes: [
    { method: 'GET', path: '/merchants', handler: 'productFinder.merchants', config: adminOnly },
    { method: 'GET', path: '/search', handler: 'productFinder.search', config: adminOnly },
    { method: 'POST', path: '/preview-url', handler: 'productFinder.preview', config: adminOnly },
    { method: 'POST', path: '/save', handler: 'productFinder.save', config: adminOnly },
    { method: 'POST', path: '/post-price-search', handler: 'productFinder.searchPostPrices', config: adminOnly },
  ],
};
