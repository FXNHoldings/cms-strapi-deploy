import crypto from 'crypto';
import axios from 'axios';

/**
 * Lifecycle hooks — fire outbound webhooks to every BlogDestination linked
 * to an article when it transitions to "published" (and autoPostOnPublish).
 */
export default {
  async afterUpdate(event) {
    await maybeFireWebhooks(event);
  },
  async afterCreate(event) {
    await maybeFireWebhooks(event);
  },
};

async function maybeFireWebhooks(event) {
  const { result } = event;
  // result.publishedAt is set when published
  if (!result?.publishedAt) return;

  const article = await strapi.entityService.findOne(
    'api::article.article',
    result.id,
    { populate: ['blogDestinations', 'category', 'tags', 'author', 'destinations', 'coverImage'] },
  );
  if (!article?.blogDestinations?.length) return;

  const log: any[] = Array.isArray(article.autopostLog) ? [...article.autopostLog] : [];
  let overallStatus: 'posted' | 'failed' | 'pending' = 'posted';

  for (const dest of article.blogDestinations) {
    if (!dest.active || !dest.autoPostOnPublish) continue;
    if (dest.schedule !== 'immediate') {
      // Defer — picked up by autopost-worker
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
        coverImage: (article as any).coverImage?.url ?? null,
        category: (article as any).category?.name ?? null,
        tags: (article as any).tags?.map((t: any) => t.name) ?? [],
        author: (article as any).author?.name ?? null,
        destinations: (article as any).destinations?.map((d: any) => d.name) ?? [],
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
    } catch (err: any) {
      overallStatus = 'failed';
      log.push({
        destination: dest.name,
        at: new Date().toISOString(),
        status: 'failed',
        error: err?.message?.slice(0, 500) ?? 'unknown',
      });
    }
  }

  await strapi.db.query('api::article.article').update({
    where: { id: article.id },
    data: { autopostStatus: overallStatus, autopostLog: log },
  });
}
