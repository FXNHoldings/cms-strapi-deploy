'use strict';

const Anthropic = require('@anthropic-ai/sdk');

function cfg(strapi, key, fallback = '') {
  return strapi.config.get(`plugin::ai-writer.${key}`) ?? fallback;
}

/* The shape used to be described in prose here and fished back out with a
   regex. It is now a schema the API enforces, so this prompt only has to
   describe the voice. */
const ARTICLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    slug: { type: 'string' },
    excerpt: { type: 'string' },
    content: { type: 'string' },
    seoTitle: { type: 'string' },
    seoDescription: { type: 'string' },
    seoKeywords: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    readingTimeMinutes: { type: 'integer' },
  },
  required: [
    'title', 'slug', 'excerpt', 'content',
    'seoTitle', 'seoDescription', 'seoKeywords', 'tags', 'readingTimeMinutes',
  ],
  additionalProperties: false,
};

function buildSystemPrompt() {
  return 'You are a senior travel journalist writing for a travel blog (flights, hotels, destinations, tips).';
}

function buildUserPrompt(params) {
  const lengthMap = { short: '400-600', medium: '800-1200', long: '1500-2200' };
  const words = lengthMap[params.length || 'medium'];

  return [
    `Topic: ${params.topic}`,
    params.destination ? `Destination: ${params.destination}` : '',
    params.category ? `Category: ${params.category}` : '',
    params.tone ? `Tone: ${params.tone}` : 'Tone: friendly, informative, trustworthy',
    params.keywords && params.keywords.length ? `Keywords to include: ${params.keywords.join(', ')}` : '',
    params.language ? `Language: ${params.language}` : 'Language: English',
    params.customInstructions ? `Additional instructions:\n${params.customInstructions}` : '',
    `Target length: ${words} words`,
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = ({ strapi }) => ({
  getOptions() {
    return {
      provider: 'anthropic',
      configured: Boolean(cfg(strapi, 'anthropicApiKey')),
      defaultModel: cfg(strapi, 'model', 'claude-opus-5'),
      maxTokens: Number(cfg(strapi, 'maxTokens', 4096)) || 4096,
    };
  },

  async callAI({ model, system, user, maxTokens }) {
    const apiKey = cfg(strapi, 'anthropicApiKey');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured. Set it in Strapi .env and restart.');
    }

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: model || cfg(strapi, 'model', 'claude-opus-5'),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: ARTICLE_SCHEMA } },
    });

    /* A refusal is a 200 with nothing usable in it, so it has to be caught
       here rather than downstream as "the model returned no content". */
    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Anthropic declined this topic (${message.stop_details?.category ?? 'no category given'}).`,
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error(`Article hit the ${maxTokens}-token ceiling and is truncated. Raise AI_WRITER_MAX_TOKENS.`);
    }

    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  },

  async generate(params) {
    const maxTokens = Number(cfg(strapi, 'maxTokens', 4096)) || 4096;
    const model = params.model || cfg(strapi, 'model', 'claude-opus-5');

    const text = await this.callAI({
      model,
      system: buildSystemPrompt(),
      user: buildUserPrompt(params),
      maxTokens,
    });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Schema-constrained output did not parse as JSON: ${error.message}`);
    }
    return { ...parsed, _meta: { provider: 'anthropic', model } };
  },
});
