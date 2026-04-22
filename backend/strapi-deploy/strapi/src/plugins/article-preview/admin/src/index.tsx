import pluginId from './pluginId';
import Initializer from './components/Initializer';
import PreviewAction from './components/PreviewAction';

const name = 'Article Preview';

export default {
  register(app) {
    app.registerPlugin({
      id: pluginId,
      initializer: Initializer,
      isReady: false,
      name,
    });
  },

  bootstrap(app) {
    const contentManager = app.getPlugin('content-manager');
    const { addDocumentAction } = contentManager.apis;

    addDocumentAction((actions) => {
      const alreadyRegistered = actions.some((action) => action === PreviewAction);
      if (alreadyRegistered) {
        return actions;
      }

      const nextActions = [...actions];
      const indexOfDeleteAction = nextActions.findIndex((action) => action.type === 'delete');

      if (indexOfDeleteAction >= 0) {
        nextActions.splice(indexOfDeleteAction, 0, PreviewAction);
      } else {
        nextActions.push(PreviewAction);
      }

      return nextActions;
    });
  },

  async registerTrads() {
    return [];
  },
};
