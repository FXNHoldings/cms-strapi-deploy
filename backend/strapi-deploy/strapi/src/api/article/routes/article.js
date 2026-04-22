'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/articles/pending-autopost',
      handler: 'article.pendingAutopost',
      config: {
        policies: [],
      },
    },
  ],
};
