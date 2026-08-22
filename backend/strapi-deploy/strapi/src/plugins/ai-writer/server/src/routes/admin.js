'use strict';

module.exports = {
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/options',
      handler: 'ai.options',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
    {
      method: 'GET',
      path: '/context/:site',
      handler: 'ai.context',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
    {
      method: 'POST',
      path: '/titles',
      handler: 'ai.titles',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
    {
      method: 'POST',
      path: '/generate',
      handler: 'ai.generate',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
  ],
};
