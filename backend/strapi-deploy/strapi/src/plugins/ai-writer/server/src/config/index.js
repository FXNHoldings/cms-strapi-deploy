'use strict';

/**
 * Anthropic only.
 *
 * This plugin routed through OpenRouter until August 2026, pinned the whole
 * time to an Anthropic model — so the gateway bought nothing but a second
 * prepaid balance to run dry, which it duly did. Calling Anthropic directly
 * removes the markup, the extra hop, and that failure mode.
 */

module.exports = {
  default: {
    anthropicApiKey: '',
    model: 'claude-opus-5',
    maxTokens: 4096,
  },
  validator(config) {
    if (typeof config.model !== 'string') {
      throw new Error('[ai-writer] config.model must be a string');
    }
  },
};
