'use strict';

const slugify = require('slugify');

module.exports = {
  async options(ctx) {
    const svc = strapi.plugin('ai-writer').service('ai');
    ctx.body = svc.getOptions();
  },

  async generate(ctx) {
    const body = ctx.request.body || {};
    if (!body.topic || typeof body.topic !== 'string') {
      return ctx.badRequest('Missing required field: topic');
    }

    const svc = strapi.plugin('ai-writer').service('ai');
    const draft = await svc.generate({
      topic: body.topic,
      tone: body.tone,
      length: body.length,
      destination: body.destination,
      category: body.category,
      keywords: body.keywords,
      language: body.language,
      provider: body.provider,
      model: body.model,
      customInstructions: body.customInstructions,
    });

    if (!draft.slug) {
      draft.slug = slugify(draft.title, { lower: true, strict: true }).slice(0, 60);
    }

    let created = null;
    if (body.createDraft !== false) {
      created = await strapi.entityService.create('api::article.article', {
        data: {
          title: draft.title,
          slug: draft.slug,
          excerpt: draft.excerpt,
          content: draft.content,
          seoTitle: draft.seoTitle,
          seoDescription: draft.seoDescription,
          seoKeywords: draft.seoKeywords,
          readingTimeMinutes: draft.readingTimeMinutes,
          source: 'ai',
        },
      });
    }

    const meta = draft._meta || {};
    delete draft._meta;
    ctx.body = { draft, created, meta };
  },
};
