'use strict';

/**
 * Article lifecycles
 *
 * Two side-effects on create / update:
 *   1. Webhooks to any BlogDestinations marked `autoPostOnPublish` (unchanged).
 *   2. AI image generation when `aiImageStatus` transitions to `"requested"`.
 *
 * Triggering AI images from Strapi admin:
 *   1) Open an Article in Content Manager.
 *   2) Change  "aiImageStatus"  from  idle  →  requested.
 *   3) Click Save.
 *   4) Refresh after ~10-20 seconds — cover + gallery will be attached and the
 *      status flips to  done  (or  failed  with a message in
 *      aiImageStatusMessage).
 *
 * Required env vars on the Strapi host:
 *   FAL_KEY              — fal.ai API key
 *   ANTHROPIC_API_KEY    — Claude key (used to write the 3 image prompts)
 *   CLAUDE_MODEL         — optional, defaults to claude-sonnet-4-5-20250929
 *   FAL_IMAGE_MODEL      — optional, defaults to fal-ai/flux/schnell
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const slugify = require('slugify');

module.exports = {
  async afterUpdate(event) {
    await maybeFireWebhooks(event);
    await maybeGenerateAiImages(event);
  },
  async afterCreate(event) {
    await maybeFireWebhooks(event);
    await maybeGenerateAiImages(event);
  },
};

/* ============================================================== */
/*  AI image generation                                           */
/* ============================================================== */

async function maybeGenerateAiImages(event) {
  const { result } = event;
  if (!result || result.aiImageStatus !== 'requested') return;

  // Kick off async — don't block the admin Save request.
  setImmediate(() => {
    runImageGeneration(result.id).catch((err) => {
      strapi.log.error(`[ai-images] unhandled error for article ${result.id}: ${err && err.stack ? err.stack : err}`);
    });
  });
}

async function runImageGeneration(articleId) {
  const logPrefix = `[ai-images #${articleId}]`;

  const FAL_KEY = process.env.FAL_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FAL_KEY) return markFailed(articleId, 'FAL_KEY env var is not set on the Strapi server.');
  if (!ANTHROPIC_API_KEY) return markFailed(articleId, 'ANTHROPIC_API_KEY env var is not set on the Strapi server.');

  // Guard against concurrent runs on repeated saves.
  await strapi.db.query('api::article.article').update({
    where: { id: articleId },
    data: { aiImageStatus: 'generating', aiImageStatusMessage: null },
  });

  let article;
  try {
    article = await strapi.entityService.findOne('api::article.article', articleId, {
      populate: ['category', 'destinations'],
    });
  } catch (e) {
    return markFailed(articleId, `Could not reload article: ${safeMsg(e)}`);
  }
  if (!article) return markFailed(articleId, 'Article not found after status change.');

  strapi.log.info(`${logPrefix} starting generation for "${(article.title || '').slice(0, 70)}"`);

  let prompts;
  try {
    prompts = await generateImagePrompts(article);
  } catch (e) {
    return markFailed(articleId, `Claude prompt step failed: ${safeMsg(e)}`);
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
      const fileId = await uploadUrlToStrapi(url, `${baseName}-${kind}`);
      return { kind, fileId };
    }));

    coverId = (results.find((r) => r.kind === 'cover') || {}).fileId || null;
    for (const r of results) if (r.kind !== 'cover') galleryIds.push(r.fileId);
  } catch (e) {
    return markFailed(articleId, `Image generation failed: ${safeMsg(e)}`);
  }

  try {
    await strapi.db.query('api::article.article').update({
      where: { id: articleId },
      data: {
        coverImage: coverId,
        gallery: galleryIds,
        aiImageStatus: 'done',
        aiImageStatusMessage: `Generated ${1 + galleryIds.length} images at ${new Date().toISOString()}`,
      },
    });
    strapi.log.info(`${logPrefix} done — cover=${coverId} gallery=[${galleryIds.join(',')}]`);
  } catch (e) {
    return markFailed(articleId, `Saving images to article failed: ${safeMsg(e)}`);
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

/**
 * Download a remote URL and hand it to Strapi's internal upload service so it
 * lands in the Media Library. Returns the new file id.
 */
async function uploadUrlToStrapi(url, filename) {
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

async function markFailed(articleId, message) {
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

/* ============================================================== */
/*  Existing blog-destination webhook dispatch (unchanged)        */
/* ============================================================== */

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
