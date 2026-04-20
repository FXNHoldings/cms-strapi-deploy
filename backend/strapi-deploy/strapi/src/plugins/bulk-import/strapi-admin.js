const PLUGIN_ID = 'bulk-import';
const PLUGIN_NAME = 'Bulk Import';

export default {
  register(app) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: async () => {
        const { Upload } = await import('@strapi/icons');
        return Upload;
      },
      intlLabel: { id: `${PLUGIN_ID}.plugin.name`, defaultMessage: PLUGIN_NAME },
      Component: async () => {
        const mod = await import('./admin/src/pages/App');
        return mod.App || mod.default;
      },
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: null,
      isReady: false,
      name: PLUGIN_NAME,
    });
  },
  bootstrap() {},
  registerTrads() {
    return [];
  },
};
