'use strict';
module.exports = {
  default: {
    anthropicApiKey: '',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
  },
  validator(config) {
    if (typeof config.model !== 'string') {
      throw new Error('[ai-writer] config.model must be a string');
    }
  },
};
