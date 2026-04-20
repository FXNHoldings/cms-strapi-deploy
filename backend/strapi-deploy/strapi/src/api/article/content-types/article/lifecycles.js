'use strict';
const crypto = require('crypto');
const axios = require('axios');

module.exports = {
  async afterUpdate(event) { await maybeFireWebhooks(event); },
  async afterCreate(event) { await maybeFireWebhooks(event); },
};

async function maybeFireWebhooks(event) {
  const { result } = event;
  if (!result || !result.publishedAt) return;

  const article = await strapi.entityService.findOne(
    'api::article.article',
    result.id,
    { populate: ['blogDestinations', 'category', 'tags', 'author', 'destinations', 'coverImage'] },
  );
  if (!article || !article.blogDestinations || !article.blogDestinations.length) return;

  const log = Array.isArray(article.autopostLog) ? [...article.autopostLog] : [];
  let overallStatus = 'posted';

  for (const dest of article.blogDestinations) {
    if (!dest.active || !dest.autoPostOnPublish) continue;
    if (dest.schedule !== 'immediate') {
      overallStatus = overallStatus === 'failed' ? 'failed' : 'pending';
      continue;
    }

    const payload = {
      event: 'article.published',
      article: {
        id: article.id,
        title: article.title,
        slug: article.slug,
        excerpt: article.excerpt,
        content: article.content,
        coverImage: article.coverImage && article.coverImage.url ? article.coverImage.url : null,
        category: article.category && article.category.name ? article.category.name : null,
        tags: (article.tags || []).map((t) => t.name),
        author: article.author && article.author.name ? article.author.name : null,
        destinations: (article.destinations || []).map((d) => d.name),
        publishedAt: article.publishedAt,
      },
    };
    const body = JSON.stringify(payload);
    const signature = dest.webhookSecret
      ? crypto.createHmac('sha256', dest.webhookSecret).update(body).digest('hex')
      : null;

    try {
      await axios.post(dest.webhookUrl, payload, {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          ...(signature ? { 'X-FXN-Signature': signature } : {}),
          ...(dest.authHeader ? { Authorization: dest.authHeader } : {}),
        },
      });
      log.push({ destination: dest.name, at: new Date().toISOString(), status: 'posted' });
    } catch (err) {
      overallStatus = 'failed';
      log.push({
        destination: dest.name,
        at: new Date().toISOString(),
        status: 'failed',
        error: (err && err.message ? err.message : 'unknown').slice(0, 500),
      });
    }
  }

  await strapi.db.query('api::article.article').update({
    where: { id: article.id },
    data: { autopostStatus: overallStatus, autopostLog: log },
  });
}
