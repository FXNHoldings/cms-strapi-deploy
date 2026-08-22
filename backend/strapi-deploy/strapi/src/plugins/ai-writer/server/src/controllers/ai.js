'use strict';

const slugify = require('slugify');

module.exports = {
  async options(ctx) {
    const svc = strapi.plugin('ai-writer').service('ai');
    const sites = await strapi.plugin('ai-writer').service('sites').listSites();
    ctx.body = { ...svc.getOptions(), sites };
  },

  /* Categories and recent uploads for one site, so the form offers what exists
     instead of asking for a category to be typed and hoping it matches. */
  async context(ctx) {
    const siteSvc = strapi.plugin('ai-writer').service('sites');
    const { site, error } = await siteSvc.resolveSite(ctx.params.site);
    if (error) return ctx.badRequest(error);

    const { categories, products } = await siteSvc.siteContext(site);

    let media = [];
    try {
      const files = await strapi.plugin('upload').service('upload').findMany({
        filters: { mime: { $startsWith: 'image/' } },
        sort: { createdAt: 'desc' },
        limit: 40,
      });
      media = files.map((f) => ({ id: f.id, name: f.name, url: f.url, width: f.width, height: f.height }));
    } catch (e) {
      strapi.log.warn(`[ai-writer] media list: ${e.message}`);
    }

    ctx.body = { categories, media, productCount: products.length };
  },

  /* Titles for a category, so a run can start from "give me five" rather than
     from a blank box. Nothing is written — these are suggestions to edit. */
  async titles(ctx) {
    const body = ctx.request.body || {};
    const siteSvc = strapi.plugin('ai-writer').service('sites');
    const { site, uid, error } = await siteSvc.resolveSite(body.site);
    if (error) return ctx.badRequest(error);

    const { categories } = await siteSvc.siteContext(site);
    const category = categories.find((c) => c.slug === body.category);
    if (!category) return ctx.badRequest('Pick one of this site\'s categories first.');

    /* What this category already has, so the model is not asked to guess. */
    let existing = [];
    try {
      const rows = await strapi.documents(uid).findMany({
        filters: { categories: { slug: category.slug } },
        status: 'published',
        limit: 60,
        sort: 'publishDate:desc',
      });
      existing = rows.map((r) => r.title).filter(Boolean);
    } catch (e) {
      strapi.log.warn(`[ai-writer] existing titles for ${category.slug}: ${e.message}`);
    }

    const count = Math.min(Math.max(Number(body.count) || 5, 1), 15);
    const titles = await strapi.plugin('ai-writer').service('ai').titles({
      brief: site.aiWriterBrief,
      category: category.name,
      count,
      existing,
      model: body.model,
    });

    ctx.body = { titles, category: category.slug, avoided: existing.length };
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

    const context = await siteSvc.siteContext(site);

    /*
     * Errors from here are the writer's own — a token ceiling, a refusal, a
     * missing key — and each says exactly what to do. Letting them escape turns
     * all of them into "Unknown Server Error" in the admin, which is what a
     * truncated article looked like from the outside.
     */
    const svc = strapi.plugin('ai-writer').service('ai');
    let draft;
    try {
      draft = await svc.generate({
        categories: context.categories,
        products: context.products,
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
    } catch (error) {
      return ctx.badRequest(error.message || 'Generation failed.');
    }

    if (!draft.slug) {
      draft.slug = slugify(draft.title, { lower: true, strict: true }).slice(0, 60);
    }

    /*
     * Strip product markers that name a slug this site does not have.
     *
     * The marker is only swapped for a product card when the slug resolves; an
     * invented one survives to the published page as the literal text
     * ::product:whatever::. Dropping it here means the worst case is a missing
     * product box rather than machine syntax in front of a reader.
     */
    const known = new Set(context.products.map((p) => p.slug));
    const dropped = [];
    draft.content = String(draft.content || '').replace(
      /^[ \t]*::product:([a-z0-9-]+)::[ \t]*$/gim,
      (match, slug) => {
        if (known.has(slug)) return match;
        dropped.push(slug);
        return '';
      },
    );

    /* Same rule for the category: offered by slug, verified before use. */
    const category = context.categories.find((c) => c.slug === draft.categorySlug) ?? null;

    let created = null;
    let generatedCover = null;
    let coverError = null;
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
        keyTakeaways: draft.keyTakeaway,
        source: 'ai',
        // Only when the caller actually picked one; the field is a plain string
        // on this type, so an empty value would blank an existing cover.
        ...(body.coverImageUrl ? { coverImageUrl: String(body.coverImageUrl) } : {}),
      });

      /*
       * A generated cover, when asked for. Done after the article so the prompt
       * can use its real title and excerpt rather than the topic line, and
       * non-fatal: a failed image should leave the writing intact rather than
       * throwing the whole run away.
       */
      if (body.generateCover && !body.coverImageId && strapi.contentTypes[uid]?.attributes?.coverImage) {
        const made = await strapi.plugin('ai-writer').service('cover').generate({
          title: draft.title,
          excerpt: draft.excerpt,
          brief: site.aiWriterBrief,
        });
        if (made.error) coverError = made.error;
        else generatedCover = made.file;
      }

      /* Relations and media are excluded by pickWritable — it cannot know which
         side of a relation a value belongs to — so they are attached here, by
         id, only once verified. */
      if (category && strapi.contentTypes[uid]?.attributes?.categories) {
        data.categories = [category.documentId];
      }
      if (body.coverImageId && strapi.contentTypes[uid]?.attributes?.coverImage) {
        data.coverImage = body.coverImageId;
      } else if (generatedCover) {
        data.coverImage = generatedCover.id;
      }

      created = await strapi.documents(uid).create({ data, status: 'draft' });
    }

    const meta = draft._meta || {};
    delete draft._meta;
    ctx.body = {
      draft,
      created,
      meta,
      site: { slug: site.slug, name: site.name, target: uid, usedBrief: Boolean((site.aiWriterBrief || '').trim()) },
      // Surfaced rather than swallowed: a dropped marker means the model reached
      // for a product this site does not carry, which is worth seeing.
      products: { offered: context.products.length, dropped },
      cover: generatedCover ? { id: generatedCover.id, url: generatedCover.url } : null,
      coverError,
      category: category ? category.slug : null,
    };
  },
};
