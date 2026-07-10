'use strict';

module.exports = () => {
  return async (ctx, next) => {
    await next();

    const isAdminShell = ctx.path === '/admin' || ctx.path === '/admin/';
    if (isAdminShell && ctx.response.is('html')) {
      ctx.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      ctx.set('Pragma', 'no-cache');
      ctx.set('Expires', '0');
    }
  };
};
