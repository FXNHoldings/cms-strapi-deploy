'use strict';

/**
 * AI image generation worker.
 *
 * Runs from bootstrap (see src/index.js), not from a lifecycle's setImmediate,
 * so DB operations start in a clean AsyncLocalStorage context. Lifecycles
 * defer via setImmediate/setTimeout inherit the parent request's closed
 * transaction and fail with "Transaction query already complete".
 *
 * Trigger flow:
 *   admin sets aiImageStatus='requested' and saves
 *   → poller picks up the article within POLL_INTERVAL_MS
 *   → sets status='generating' (claims it)
 *   → generates prompts (Claude) + 3 images (fal.ai) + uploads them
 *   → sets status='done' with coverImage + gallery attached
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const slugify = require('slugify');

const POLL_INTERVAL_MS = 5000;
const inFlight = new Set();

async function pollOnce(strapi) {
  const pending = await strapi.db.query('api::article.article').findMany({
    where: { aiImageStatus: 'requested' },
    select: ['id'],
    limit: 10,
  });
  for (const { id } of pending) {
    if (inFlight.has(id)) continue;
    inFlight.add(id);
    runImageGeneration(strapi, id)
      .catch((err) => {
        strapi.log.error(`[ai-images #${id}] unhandled: ${err && err.stack ? err.stack : err}`);
      })
      .finally(() => inFlight.delete(id));
  }
}

function startPoller(strapi) {
  strapi.log.info(`[ai-images] poller started (every ${POLL_INTERVAL_MS}ms)`);
  setInterval(() => {
    pollOnce(strapi).catch((err) => {
      strapi.log.error(`[ai-images poll] ${err && err.message ? err.message : err}`);
    });
  }, POLL_INTERVAL_MS);
}

async function runImageGeneration(strapi, articleId) {
  const logPrefix = `[ai-images #${articleId}]`;

  const FAL_KEY = process.env.FAL_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FAL_KEY) return markFailed(strapi, articleId, 'FAL_KEY env var is not set on the Strapi server.');
  if (!ANTHROPIC_API_KEY) return markFailed(strapi, articleId, 'ANTHROPIC_API_KEY env var is not set on the Strapi server.');

  try {
    await strapi.db.query('api::article.article').update({
      where: { id: articleId },
      data: { aiImageStatus: 'generating', aiImageStatusMessage: null },
    });
  } catch (e) {
    return markFailed(strapi, articleId, `Could not mark article as generating: ${safeMsg(e)}`);
  }

  let article;
  try {
    article = await strapi.entityService.findOne('api::article.article', articleId, {
      populate: ['category', 'destinations'],
    });
  } catch (e) {
    return markFailed(strapi, articleId, `Could not reload article: ${safeMsg(e)}`);
  }
  if (!article) return markFailed(strapi, articleId, 'Article not found after status change.');

  strapi.log.info(`${logPrefix} starting generation for "${(article.title || '').slice(0, 70)}"`);

  let prompts;
  try {
    prompts = await generateImagePrompts(article);
  } catch (e) {
    return markFailed(strapi, articleId, `Claude prompt step failed: ${safeMsg(e)}`);
  }

  let coverId = null;
  const galleryIds = [];
  try {
    const { fal } = await import('@fal-ai/client');
    fal.config({ credentials: FAL_KEY });

    const model = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';
    const baseName = slugify(article.title || `article-${articleId}`, { lower: true, strict: true }).slice(0, 50);

    const all = [
      { kind: 'cover', prompt: prompts.cover, aspect: 'landscape_16_9' },
      ...prompts.gallery.slice(0, 2).map((p, i) => ({ kind: `gallery-${i + 1}`, prompt: p, aspect: 'landscape_4_3' })),
    ];

    const results = await Promise.all(all.map(async ({ kind, prompt, aspect }) => {
      const res = await fal.subscribe(model, {
        input: { prompt, image_size: aspect, num_images: 1, enable_safety_checker: true },
        logs: false,
      });
      const url = res && res.data && res.data.images && res.data.images[0] && res.data.images[0].url;
      if (!url) throw new Error(`Fal.ai returned no image URL for ${kind}`);
      const fileId = await uploadUrlToStrapi(strapi, url, `${baseName}-${kind}`);
      return { kind, fileId };
    }));

    coverId = (results.find((r) => r.kind === 'cover') || {}).fileId || null;
    for (const r of results) if (r.kind !== 'cover') galleryIds.push(r.fileId);
  } catch (e) {
    return markFailed(strapi, articleId, `Image generation failed: ${safeMsg(e)}`);
  }

  try {
    const doc = await strapi.db.query('api::article.article').findOne({
      where: { id: articleId },
      select: ['documentId', 'publishedAt'],
    });
    if (!doc || !doc.documentId) throw new Error('Missing documentId for article');
    const data = {
      coverImage: coverId,
      gallery: galleryIds,
      aiImageStatus: 'done',
      aiImageStatusMessage: `Generated ${1 + galleryIds.length} images at ${new Date().toISOString()}`,
    };
    // Always update the draft so the admin editor shows the image.
    await strapi.documents('api::article.article').update({
      documentId: doc.documentId,
      status: 'draft',
      data,
    });
    // If the article is published, also update the published version so the
    // public API (and the Vercel frontend) sees the image.
    if (doc.publishedAt) {
      await strapi.documents('api::article.article').update({
        documentId: doc.documentId,
        status: 'published',
        data,
      });
    }
    strapi.log.info(`${logPrefix} done — cover=${coverId} gallery=[${galleryIds.join(',')}]`);
  } catch (e) {
    return markFailed(strapi, articleId, `Saving images to article failed: ${safeMsg(e)}`);
  }
}

async function generateImagePrompts(article) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

  const categoryName = article.category && article.category.name ? article.category.name : 'Travel';
  const destinations = (article.destinations || []).map((d) => d.name).filter(Boolean).join(', ');

  const systemPrompt = `You write photographic prompts for a travel blog.
Output MUST be strict JSON: { "cover": string, "gallery": [string, string] }.
- cover: 16:9 landscape hero photo, 40-60 words, photorealistic, vivid travel scene, specific location/subject, time of day, lighting.
- gallery: exactly 2 supporting photos (different angles / subjects from the same article). Same style guidance.
- No people's faces close up, no logos, no text, no brand names.
Return ONLY the JSON — no markdown fences, no prose.`;

  const userPrompt = [
    `Article title: ${article.title}`,
    article.excerpt ? `Excerpt: ${article.excerpt}` : '',
    `Category: ${categoryName}`,
    destinations ? `Destinations: ${destinations}` : '',
  ].filter(Boolean).join('\n');

  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  let json;
  try { json = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { json = JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  if (!json || !json.cover || !Array.isArray(json.gallery) || json.gallery.length < 2) {
    throw new Error(`Claude did not return valid image prompts: ${text.slice(0, 200)}`);
  }
  return json;
}

async function uploadUrlToStrapi(strapi, url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';

  const tmp = path.join(os.tmpdir(), `${filename}-${Date.now()}.${ext}`);
  fs.writeFileSync(tmp, buf);
  const stats = fs.statSync(tmp);

  try {
    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: {},
      files: {
        filepath: tmp,
        originalFilename: `${filename}.${ext}`,
        mimetype: mime,
        size: stats.size,
      },
    });
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!file || !file.id) throw new Error('Strapi upload returned no id');
    return file.id;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function markFailed(strapi, articleId, message) {
  strapi.log.warn(`[ai-images #${articleId}] FAILED — ${message}`);
  try {
    await strapi.db.query('api::article.article').update({
      where: { id: articleId },
      data: { aiImageStatus: 'failed', aiImageStatusMessage: message.slice(0, 500) },
    });
  } catch (e) {
    strapi.log.error(`[ai-images #${articleId}] could not even write failure state: ${safeMsg(e)}`);
  }
}

function safeMsg(e) {
  if (!e) return 'unknown error';
  if (e.message) return String(e.message).slice(0, 400);
  return String(e).slice(0, 400);
}

module.exports = { startPoller };
