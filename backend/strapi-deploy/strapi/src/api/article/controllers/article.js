'use strict';
const { factories } = require('@strapi/strapi');

module.exports = factories.createCoreController('api::article.article', ({ strapi }) => ({
  async pendingAutopost(ctx) {
    const articles = await strapi.entityService.findMany('api::article.article', {
      filters: {
        publishedAt: { $notNull: true },
        autopostStatus: { $in: ['pending', 'none'] },
      },
      populate: {
        blogDestinations: true,
        category: { fields: ['name'] },
        tags: { fields: ['name'] },
        destinations: { fields: ['name'] },
        author: { fields: ['name'] },
        coverImage: { fields: ['url'] },
      },
      pagination: {
        pageSize: 50,
      },
    });

    ctx.body = {
      data: articles.map((article) => ({
        ...article,
        blogDestinations: (article.blogDestinations || []).map((dest) => ({
          name: dest.name,
          webhookUrl: dest.webhookUrl,
          webhookSecretValue: dest.webhookSecret,
          authHeader: dest.authHeader,
          schedule: dest.schedule,
          active: dest.active,
          autoPostOnPublish: dest.autoPostOnPublish,
        })),
      })),
    };
  },
}));
