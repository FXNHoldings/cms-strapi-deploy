'use strict';
module.exports = {
  type: 'admin',
  routes: [
    {
      method: 'POST',
      path: '/generate',
      handler: 'ai.generate',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
  ],
};
