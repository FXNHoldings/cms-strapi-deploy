'use strict';

module.exports = {
  default: {
    provider: 'openrouter',
    anthropicApiKey: '',
    model: 'claude-sonnet-4-5-20250929',
    openrouterApiKey: '',
    openrouterModel: 'anthropic/claude-sonnet-4.6',
    openrouterBaseUrl: 'https://openrouter.ai/api/v1',
    openrouterSiteUrl: 'https://cms.fxnstudio.com',
    openrouterAppName: 'Strapi AI Writer',
    maxTokens: 4096,
  },
  validator(config) {
    if (typeof config.model !== 'string') {
      throw new Error('[ai-writer] config.model must be a string');
    }
    if (config.provider && !['openrouter', 'anthropic'].includes(config.provider)) {
      throw new Error('[ai-writer] config.provider must be openrouter or anthropic');
    }
  },
};
