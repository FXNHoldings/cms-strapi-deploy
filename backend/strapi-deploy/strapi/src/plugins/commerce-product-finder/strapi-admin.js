import PostPriceSearchAction from './admin/src/components/PostPriceSearchAction';
import { useEffect } from 'react';
import { ShoppingCart } from '@strapi/icons';

const PLUGIN_ID = 'commerce-product-finder';
const PLUGIN_NAME = 'Commerce Products';

const Initializer = ({ setPlugin }) => {
  useEffect(() => {
    setPlugin(PLUGIN_ID);
  }, [setPlugin]);

  return null;
};

export default {
  register(app) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: ShoppingCart,
      intlLabel: { id: `${PLUGIN_ID}.plugin.name`, defaultMessage: PLUGIN_NAME },
      Component: async () => {
        const mod = await import('./admin/src/pages/App');
        return mod.App || mod.default;
      },
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_NAME,
    });
  },
  bootstrap(app) {
    const contentManager = app.getPlugin('content-manager');
    const { addDocumentAction } = contentManager.apis;

    addDocumentAction((actions) => {
      if (actions.some((action) => action === PostPriceSearchAction)) {
        return actions;
      }

      const nextActions = [...actions];
      const indexOfDeleteAction = nextActions.findIndex((action) => action.type === 'delete');

      if (indexOfDeleteAction >= 0) {
        nextActions.splice(indexOfDeleteAction, 0, PostPriceSearchAction);
      } else {
        nextActions.push(PostPriceSearchAction);
      }

      return nextActions;
    });
  },
  registerTrads() {
    return [];
  },
};
