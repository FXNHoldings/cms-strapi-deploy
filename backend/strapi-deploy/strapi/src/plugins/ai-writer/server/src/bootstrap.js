'use strict';

module.exports = ({ strapi }) => {
  const provider = strapi.config.get('plugin::ai-writer.provider') || 'openrouter';
  const model =
    provider === 'openrouter'
      ? strapi.config.get('plugin::ai-writer.openrouterModel')
      : strapi.config.get('plugin::ai-writer.model');
  strapi.log.info(`[ai-writer] bootstrapped — provider=${provider} model=${model || 'default'}`);
};
