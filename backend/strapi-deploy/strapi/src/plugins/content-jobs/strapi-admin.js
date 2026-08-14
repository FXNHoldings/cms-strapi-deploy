import { useEffect } from 'react';
import { Play } from '@strapi/icons';

const PLUGIN_ID = 'content-jobs';
const PLUGIN_NAME = 'Content Jobs';

const Initializer = ({ setPlugin }) => {
  useEffect(() => { setPlugin(PLUGIN_ID); }, [setPlugin]);
  return null;
};

export default {
  register(app) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: Play,
      intlLabel: { id: `${PLUGIN_ID}.plugin.name`, defaultMessage: PLUGIN_NAME },
      Component: () =>
        import('./admin/src/pages/App').then((mod) => ({ default: mod.App || mod.default })),
    });
    app.registerPlugin({ id: PLUGIN_ID, initializer: Initializer, isReady: false, name: PLUGIN_NAME });
  },
  bootstrap() {},
  registerTrads() { return []; },
};
