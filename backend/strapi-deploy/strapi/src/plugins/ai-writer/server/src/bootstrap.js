'use strict';
module.exports = ({ strapi }) => {
  strapi.log.info('[ai-writer] bootstrapped — model=' + (strapi.config.get('plugin::ai-writer.model') || 'default'));
};
