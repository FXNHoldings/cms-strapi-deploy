'use strict';

const slugify = require('slugify');

module.exports = {
  async options(ctx) {
    const svc = strapi.plugin('ai-writer').service('ai');
    const sites = await strapi.plugin('ai-writer').service('sites').listSites();
    ctx.body = { ...svc.getOptions(), sites };
  },

  async generate(ctx) {
    const body = ctx.request.body || {};
    if (!body.topic || typeof body.topic !== 'string') {
      return ctx.badRequest('Missing required field: topic');
    }

    /*
     * Which site, and therefore which collection. Previously every draft was
     * created in api::article.article no matter which site's dashboard this
     * was opened from — a collection that belongs to no site here, so the post
     * was filed where the site does not read and never appeared.
     *
     * Refusing without a site is deliberate: silently defaulting is what made
     * the old behaviour so hard to notice.
     */
    const siteSvc = strapi.plugin('ai-writer').service('sites');
    const { site, uid, error } = await siteSvc.resolveSite(body.site);
    if (error) return ctx.badRequest(error);

    const svc = strapi.plugin('ai-writer').service('ai');
    const draft = await svc.generate({
      topic: body.topic,
      tone: body.tone,
      length: body.length,
      destination: body.destination,
      subjectLabel: body.subjectLabel,
      category: body.category,
      keywords: body.keywords,
      language: body.language,
      model: body.model,
      customInstructions: body.customInstructions,
      brief: site.aiWriterBrief,
    });

    if (!draft.slug) {
      draft.slug = slugify(draft.title, { lower: true, strict: true }).slice(0, 60);
    }

    let created = null;
    if (body.createDraft !== false) {
      /*
       * Only fields the target declares. The post types genuinely disagree —
       * `tags` is json on nxtsmarthome-post and a relation on article — and
       * writing an array into a relation fails the whole create.
       *
       * status: 'draft' is not a default worth changing lightly. Generated
       * copy on a review site can assert things it has no business asserting;
       * it belongs in front of a person before it is public.
       */
      const data = siteSvc.pickWritable(uid, {
        title: draft.title,
        slug: draft.slug,
        excerpt: draft.excerpt,
        content: draft.content,
        seoTitle: draft.seoTitle,
        seoDescription: draft.seoDescription,
        seoKeywords: draft.seoKeywords,
        readingTimeMinutes: draft.readingTimeMinutes,
        tags: draft.tags,
        source: 'ai',
      });

      created = await strapi.documents(uid).create({ data, status: 'draft' });
    }

    const meta = draft._meta || {};
    delete draft._meta;
    ctx.body = {
      draft,
      created,
      meta,
      site: { slug: site.slug, name: site.name, target: uid, usedBrief: Boolean((site.aiWriterBrief || '').trim()) },
    };
  },
};
