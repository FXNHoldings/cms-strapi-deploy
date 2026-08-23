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
    /* Rendered as "The short answer" above the article. Two sentences at most:
       it is a summary box, not an intro paragraph. */
    keyTakeaway: { type: 'string' },
    /* Must be one of the slugs offered in the prompt. Validated after
       generation — a category that does not exist is dropped, not created. */
    categorySlug: { type: 'string' },
    /* Rendered as the "Questions Answered" accordion, and as FAQPage structured
       data. Real questions a reader would ask, not restatements of the headings. */
    faq: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
        },
        required: ['question', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'title', 'slug', 'excerpt', 'content',
    'seoTitle', 'seoDescription', 'seoKeywords', 'tags', 'readingTimeMinutes',
    'keyTakeaway', 'faq',
  ],
  additionalProperties: false,
};

/*
 * The site's own brief, when it has one.
 *
 * This used to return the travel line unconditionally, so every site on this
 * CMS — a smart-home review site included — was written as travel copy. The
 * brief now comes from commerce-site.aiWriterBrief, and the travel wording is
 * only the fallback for a site that has not set one.
 */
/* Titles for a category, avoiding what the site has already published. */
const TITLES_SCHEMA = {
  type: 'object',
  properties: {
    titles: { type: 'array', items: { type: 'string' } },
  },
  required: ['titles'],
  additionalProperties: false,
};

/* Backfill shape: questions only, for an article that already exists. */
const FAQ_SCHEMA = {
  type: 'object',
  properties: {
    faq: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, answer: { type: 'string' } },
        required: ['question', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['faq'],
  additionalProperties: false,
};

function buildSystemPrompt(brief) {
  const own = (brief || '').trim();
  if (own) return own;
  return 'You are a senior travel journalist writing for a travel blog (flights, hotels, destinations, tips).';
}

function buildUserPrompt(params) {
  const lengthMap = { short: '400-600', medium: '800-1200', long: '1500-2200' };
  const words = lengthMap[params.length || 'medium'];

  return [
    `Topic: ${params.topic}`,
    params.destination ? `${params.subjectLabel || 'Destination'}: ${params.destination}` : '',
    params.category ? `Category: ${params.category}` : '',
    params.tone ? `Tone: ${params.tone}` : 'Tone: friendly, informative, trustworthy',
    params.keywords && params.keywords.length ? `Keywords to include: ${params.keywords.join(', ')}` : '',
    params.language ? `Language: ${params.language}` : 'Language: English',
    params.customInstructions ? `Additional instructions:\n${params.customInstructions}` : '',
    `Target length: ${words} words`,
    '',
    'Structure: at least four H2 sections written as markdown "## Heading". The',
    'site builds its "In this guide" contents list from those headings and hides',
    'it below three, so fewer than four leaves the article without one.',
    '',
    'keyTakeaway: one or two sentences answering the title directly. It is shown',
    'in a box above the article as "The short answer", so it must stand alone.',
    '',
    'faq: four or five questions a reader would actually type, each answered in',
    'two or three sentences. They appear as an accordion and as FAQPage',
    'structured data, so an answer has to make sense on its own, away from the',
    'article. Do not restate the section headings as questions. Questions must be',
    'under 300 characters.',
    '',
    'Hard limits, because these are stored fields and an overlong value is',
    'truncated: seoTitle 60 characters, seoDescription 160, excerpt 300.',
    '',
    params.categories?.length
      ? [
          'categorySlug: choose exactly one of these, by slug. Do not invent one:',
          params.categories.map((c) => `  ${c.slug} — ${c.name}`).join('\n'),
        ].join('\n')
      : '',
    '',
    params.products?.length
      ? [
          'Products: reference real products from the catalogue below by placing a',
          'marker on its own line, exactly ::product:<slug>:: — the site replaces it',
          'with a photo, verdict and buy buttons. Place two or three, each in the',
          'section that genuinely discusses that product. Never place one in a',
          'section that does not mention it, and never invent a slug: anything not',
          'on this list is stripped out and the reference is wasted.',
          params.products.map((p) => `  ${p.slug} — ${p.name}`).join('\n'),
        ].join('\n')
      : '',
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

  async callAI({ model, system, user, maxTokens, schema }) {
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
      output_config: { format: { type: 'json_schema', schema: schema || ARTICLE_SCHEMA } },
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

  /**
   * Article titles for one category.
   *
   * The existing titles are passed in and the model is told to avoid them —
   * without that it reliably proposes the article the site already has, and
   * the duplicate is only noticed after it has been written and filed.
   */
  async titles({ brief, category, count = 5, existing = [], model }) {
    const maxTokens = Math.min(Number(cfg(strapi, 'maxTokens', 4096)) || 4096, 2048);

    const user = [
      `Propose ${count} article titles for the "${category}" category of this publication.`,
      '',
      'Each must be a distinct article someone would search for, specific enough to',
      'write without further briefing. No numbering, no colons used as filler, no',
      'clickbait. Match the publication\'s market and voice as described above.',
      existing.length
        ? `\nDo NOT propose anything that overlaps these, which are already published:\n${existing.map((t) => `  ${t}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');

    const text = await this.callAI({
      model: model || cfg(strapi, 'model', 'claude-opus-5'),
      system: buildSystemPrompt(brief),
      user,
      maxTokens,
      schema: TITLES_SCHEMA,
    });

    const parsed = JSON.parse(text);
    return Array.isArray(parsed.titles) ? parsed.titles.filter(Boolean).slice(0, count) : [];
  },

  /**
   * Questions for an article that already exists.
   *
   * Given the real article rather than just its title, so the answers agree
   * with what the piece actually says — a FAQ generated from a headline alone
   * contradicts the body often enough to be worse than none, and it feeds
   * FAQPage structured data where a contradiction is a rich-result problem.
   */
  async faqFor({ brief, title, excerpt, content, count = 5, model }) {
    const body = String(content || '').slice(0, 24000);
    const user = [
      `Article title: ${title}`,
      excerpt ? `Summary: ${excerpt}` : '',
      '',
      `Write ${count} questions a reader would actually type, each answered in two or`,
      'three sentences, drawn from and consistent with the article below. Do not',
      'restate its headings as questions, and do not answer anything the article',
      'does not support. Questions must be under 300 characters.',
      '',
      '--- article ---',
      body,
    ].filter(Boolean).join('\n');

    const text = await this.callAI({
      model: model || cfg(strapi, 'model', 'claude-opus-5'),
      system: buildSystemPrompt(brief),
      user,
      maxTokens: 4000,
      schema: FAQ_SCHEMA,
    });

    const parsed = JSON.parse(text);
    return Array.isArray(parsed.faq)
      ? parsed.faq.filter((f) => f?.question && f?.answer).slice(0, count)
      : [];
  },

  async generate(params) {
    const maxTokens = Number(cfg(strapi, 'maxTokens', 4096)) || 4096;
    const model = params.model || cfg(strapi, 'model', 'claude-opus-5');

    const text = await this.callAI({
      model,
      system: buildSystemPrompt(params.brief),
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
