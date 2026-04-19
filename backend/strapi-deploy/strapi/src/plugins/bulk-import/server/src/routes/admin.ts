export default {
  type: 'admin',
  routes: [
    {
      method: 'POST',
      path: '/markdown',
      handler: 'import.markdown',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
    {
      method: 'POST',
      path: '/csv',
      handler: 'import.csv',
      config: { policies: ['admin::isAuthenticatedAdmin'] },
    },
  ],
};
