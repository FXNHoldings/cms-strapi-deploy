'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const PROVIDERS = ['openrouter', 'anthropic'];

function cfg(strapi, key, fallback = '') {
  return strapi.config.get(`plugin::ai-writer.${key}`) ?? fallback;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function buildSystemPrompt() {
  return `You are a senior travel journalist writing for a travel blog (flights, hotels, destinations, tips).
Output MUST be strict JSON matching this TypeScript type:
{
  "title": string,
  "slug": string,
  "excerpt": string,
  "content": string,
  "seoTitle": string,
  "seoDescription": string,
  "seoKeywords": string,
  "tags": string[],
  "readingTimeMinutes": number
}
Do not include any text outside the JSON. Do not wrap it in markdown fences.`;
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
    const provider = (cfg(strapi, 'provider', 'openrouter') || 'openrouter').toLowerCase();
    const anthropicKey = cfg(strapi, 'anthropicApiKey');
    const openrouterKey = cfg(strapi, 'openrouterApiKey');

    return {
      defaultProvider: PROVIDERS.includes(provider) ? provider : 'openrouter',
      providers: PROVIDERS.map((id) => ({
        id,
        configured: id === 'anthropic' ? Boolean(anthropicKey) : Boolean(openrouterKey),
        defaultModel:
          id === 'anthropic'
            ? cfg(strapi, 'model', 'claude-sonnet-4-5-20250929')
            : cfg(strapi, 'openrouterModel', 'anthropic/claude-sonnet-4.6'),
      })),
      maxTokens: Number(cfg(strapi, 'maxTokens', 4096)) || 4096,
    };
  },

  resolveProvider(requested) {
    const configured = (cfg(strapi, 'provider', 'openrouter') || 'openrouter').toLowerCase();
    const provider = (requested || configured).toLowerCase();
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`Unsupported AI provider "${provider}". Use openrouter or anthropic.`);
    }
    return provider;
  },

  async callAI({ provider, model, system, user, maxTokens }) {
    if (provider === 'openrouter') {
      const apiKey = cfg(strapi, 'openrouterApiKey');
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not configured. Set it in Strapi .env.');
      }
      const client = new OpenAI({
        apiKey,
        baseURL: cfg(strapi, 'openrouterBaseUrl', 'https://openrouter.ai/api/v1'),
      });
      const completion = await client.chat.completions.create({
        model: model || cfg(strapi, 'openrouterModel', 'anthropic/claude-sonnet-4.6'),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        extra_headers: {
          'HTTP-Referer': cfg(strapi, 'openrouterSiteUrl', 'https://cms.fxnstudio.com'),
          'X-OpenRouter-Title': cfg(strapi, 'openrouterAppName', 'Strapi AI Writer'),
        },
      });
      return completion.choices?.[0]?.message?.content?.trim() || '';
    }

    const apiKey = cfg(strapi, 'anthropicApiKey');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured. Set it in Strapi .env.');
    }
    const client = new Anthropic.default({ apiKey });
    const msg = await client.messages.create({
      model: model || cfg(strapi, 'model', 'claude-sonnet-4-5-20250929'),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  },

  async generate(params) {
    const provider = this.resolveProvider(params.provider);
    const maxTokens = Number(cfg(strapi, 'maxTokens', 4096)) || 4096;
    const model =
      params.model ||
      (provider === 'openrouter'
        ? cfg(strapi, 'openrouterModel', 'anthropic/claude-sonnet-4.6')
        : cfg(strapi, 'model', 'claude-sonnet-4-5-20250929'));

    const system = buildSystemPrompt();
    const user = buildUserPrompt(params);
    const text = await this.callAI({ provider, model, system, user, maxTokens });
    const parsed = safeParse(text);
    if (!parsed) {
      throw new Error('AI returned non-JSON output: ' + text.slice(0, 300));
    }
    return { ...parsed, _meta: { provider, model } };
  },
});
