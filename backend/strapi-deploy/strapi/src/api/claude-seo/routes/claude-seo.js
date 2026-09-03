'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/claude-seo/generate',
      handler: 'claude-seo.generate',
      config: { auth: false },
    },
  ],
};
