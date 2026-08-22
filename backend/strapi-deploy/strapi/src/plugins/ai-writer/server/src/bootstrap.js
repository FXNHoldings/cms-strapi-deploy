'use strict';

module.exports = ({ strapi }) => {
  const model = strapi.config.get('plugin::ai-writer.model');
  const configured = Boolean(strapi.config.get('plugin::ai-writer.anthropicApiKey'));
  strapi.log.info(
    `[ai-writer] bootstrapped — anthropic model=${model || 'default'} key=${configured ? 'set' : 'MISSING'}`,
  );
};
