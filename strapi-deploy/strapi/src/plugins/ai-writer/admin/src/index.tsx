import { prefixPluginTranslations } from '@strapi/strapi/admin';
import pluginId from './pluginId';
import Initializer from './components/Initializer';
import PluginIcon from './components/PluginIcon';

const name = 'AI Writer';

export default {
  register(app) {
    app.addMenuLink({
      to: `plugins/${pluginId}`,
      icon: PluginIcon,
      intlLabel: { id: `${pluginId}.plugin.name`, defaultMessage: name },
      Component: async () => {
        const { App } = await import('./pages/App');
        return App;
      },
    });

    app.registerPlugin({
      id: pluginId,
      initializer: Initializer,
      isReady: false,
      name,
    });
  },

  bootstrap() {},

  async registerTrads(app) {
    const { locales } = app;
    return Promise.all(
      (locales as string[]).map(async (locale) => {
        try {
          const { default: data } = await import(`./translations/${locale}.json`);
          return { data: prefixPluginTranslations(data, pluginId), locale };
        } catch {
          return { data: {}, locale };
        }
      }),
    );
  },
};
