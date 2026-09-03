'use strict';

const crypto = require('crypto');
const axios = require('axios');

module.exports = {
  async afterUpdate(event) {
    const { result } = event;
    if (!result?.publishedAt) return;

    const post = await strapi.entityService.findOne(
      'api::globalscholar-post.globalscholar-post',
      result.id,
      { populate: ['categories', 'author', 'coverImage'] },
    );
    if (!post) return;

    const destination = await strapi.db.query('api::blog-destination.blog-destination').findOne({
      where: { slug: 'globalscholar-one', active: true },
    });
    if (!destination?.webhookUrl || !destination?.webhookSecret) return;

    const payload = {
      event: 'article.published',
      article: {
        id: post.documentId || String(post.id),
        legacyWpId: post.legacyWpId || null,
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        content: post.content,
        contentHtml: post.content,
        coverImage: post.coverImage?.url || post.legacyFeaturedImageUrl || null,
        category: post.categories?.[0]?.name || null,
        tags: [],
        author: post.author?.name || null,
        publishedAt: post.publishedAt,
      },
    };
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', destination.webhookSecret).update(body).digest('hex');

    try {
      await axios.post(destination.webhookUrl, payload, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'X-FXN-Signature': signature },
      });
    } catch (error) {
      strapi.log.error(`[globalscholar-post] WordPress sync failed for ${post.slug}: ${error.message}`);
    }
  },
};
