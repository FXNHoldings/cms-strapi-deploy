// Plugin server entry (Strapi 5 structure)
import register from './server/src/register';
import bootstrap from './server/src/bootstrap';
import destroy from './server/src/destroy';
import config from './server/src/config';
import contentTypes from './server/src/content-types';
import controllers from './server/src/controllers';
import routes from './server/src/routes';
import services from './server/src/services';
import policies from './server/src/policies';
import middlewares from './server/src/middlewares';

export default {
  register,
  bootstrap,
  destroy,
  config,
  controllers,
  routes,
  services,
  contentTypes,
  policies,
  middlewares,
};
