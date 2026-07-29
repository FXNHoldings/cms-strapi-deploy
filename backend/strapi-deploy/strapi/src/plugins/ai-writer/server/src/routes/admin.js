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
      method: 'POST',
      path: '/generate',
      handler: 'ai.generate',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
  ],
};
