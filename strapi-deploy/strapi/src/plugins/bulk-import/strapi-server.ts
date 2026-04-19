import register from './server/src/register';
import bootstrap from './server/src/bootstrap';
import controllers from './server/src/controllers';
import routes from './server/src/routes';
import services from './server/src/services';

export default {
  register,
  bootstrap,
  controllers,
  routes,
  services,
  config: { default: {}, validator() {} },
  contentTypes: {},
  policies: {},
  middlewares: {},
};
