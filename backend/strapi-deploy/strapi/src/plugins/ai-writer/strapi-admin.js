'use strict';

const PLUGIN_ID = 'ai-writer';
const PLUGIN_NAME = 'AI Writer';

module.exports = {
  register(app) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: async () => {
        const mod = await import('./admin/src/components/PluginIcon');
        return mod.default;
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
