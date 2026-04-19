import { prefixPluginTranslations } from '@strapi/strapi/admin';
import { Upload } from '@strapi/icons';
import pluginId from './pluginId';

const Initializer = ({ setPlugin }: any) => {
  const { useEffect } = require('react');
  useEffect(() => setPlugin(pluginId), [setPlugin]);
  return null;
};

export default {
  register(app) {
    app.addMenuLink({
      to: `plugins/${pluginId}`,
      icon: Upload,
      intlLabel: { id: `${pluginId}.plugin.name`, defaultMessage: 'Bulk Import' },
      Component: async () => {
        const { App } = await import('./pages/App');
        return App;
      },
    });
    app.registerPlugin({ id: pluginId, initializer: Initializer, isReady: false, name: 'Bulk Import' });
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
