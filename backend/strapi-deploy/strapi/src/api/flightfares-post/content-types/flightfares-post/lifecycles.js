'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { marked } = require('marked');

function toWordPressHtml(content) {
  const source = String(content || '').trim();
  if (!source) return '';

  // WordPress imports already contain HTML. Preserve those instead of escaping
  // or wrapping them a second time; render editor/AI Markdown otherwise.
  if (/<\/?(?:p|h[1-6]|ul|ol|li|blockquote|table|figure|img|div|pre|hr)\b[^>]*>/i.test(source)) {
    return source;
  }

  return marked.parse(source, {
    async: false,
    gfm: true,
    breaks: false,
  });
}

function wordpressClient() {
  const url = String(process.env.WP_URL || '').replace(/\/$/, '');
  const user = process.env.WP_USER;
  const password = process.env.WP_APP_PASSWORD;
  if (!url || !user || !password) return null;
  return axios.create({
    baseURL: `${url}/wp-json/wp/v2`,
    timeout: 20000,
    auth: { username: user, password },
  });
}

async function resolveWordPressCategory(client, category) {
  const name = String(category?.name || '').trim();
  const slug = String(category?.slug || '').trim();
  if (!name && !slug) return null;

  const response = await client.get('/categories', {
    params: { slug: slug || undefined, search: slug ? undefined : name, per_page: 100 },
  });
  const exact = response.data.find((term) =>
    (slug && term.slug === slug) || (name && term.name.toLowerCase() === name.toLowerCase()),
  );
  if (exact) return exact.id;

  const created = await client.post('/categories', { name: name || slug, slug: slug || undefined });
  return created.data.id;
}

function absoluteCoverUrl(post) {
  const value = String(post.coverImage?.url || post.legacyFeaturedImageUrl || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const publicUrl = String(process.env.PUBLIC_URL || process.env.URL || '').replace(/\/$/, '');
  return publicUrl ? `${publicUrl}${value.startsWith('/') ? '' : '/'}${value}` : null;
}

function primarySeoKeyword(post) {
  const keywords = String(post.seoKeywords || '')
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  return keywords[0] || '';
}

function rankMathMeta(post) {
  const meta = {};
  if (post.seoTitle) meta.rank_math_title = String(post.seoTitle).trim();
  if (post.seoDescription) meta.rank_math_description = String(post.seoDescription).trim();
  const focusKeyword = primarySeoKeyword(post);
  if (focusKeyword) meta.rank_math_focus_keyword = focusKeyword;
  return meta;
}

async function uploadWordPressFeaturedImage(client, post, wpPost) {
  if (wpPost.featured_media) return wpPost.featured_media;
  const sourceUrl = absoluteCoverUrl(post);
  if (!sourceUrl) return null;

  const image = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const contentType = image.headers['content-type'] || 'image/jpeg';
  const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const filename = `${post.slug}-featured.${extension}`;
  const uploaded = await client.post('/media', image.data, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
  await client.post(`/media/${uploaded.data.id}`, {
    alt_text: primarySeoKeyword(post) ? `${primarySeoKeyword(post)} — ${post.title}`.slice(0, 180) : post.title,
    caption: '',
    post: wpPost.id,
  });
  return uploaded.data.id;
}

async function upsertDirectlyToWordPress(client, post, contentHtml) {
  let existing = null;
  if (post.legacyWpId) {
    try {
      existing = (await client.get(`/posts/${post.legacyWpId}`, { params: { context: 'edit' } })).data;
    } catch (error) {
      if (error.response?.status !== 404) throw error;
    }
  }
  if (!existing) {
    const response = await client.get('/posts', {
      params: { slug: post.slug, status: 'any', context: 'edit', per_page: 1 },
    });
    existing = response.data[0] || null;
  }

  const categoryId = await resolveWordPressCategory(client, post.categories?.[0]);
  const data = {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt || '',
    content: contentHtml,
    status: 'publish',
    meta: rankMathMeta(post),
  };
  if (categoryId) data.categories = [categoryId];

  const response = existing
    ? await client.post(`/posts/${existing.id}`, data)
    : await client.post('/posts', data);
  const featuredMediaId = await uploadWordPressFeaturedImage(client, post, response.data);
  if (featuredMediaId) {
    await client.post(`/posts/${response.data.id}`, { featured_media: featuredMediaId });
  }
  strapi.log.info(`[flightfares-post] WordPress ${existing ? 'updated' : 'created'} ${post.slug} as post ${response.data.id}`);
}

async function syncPublishedPost(event) {
    const { result } = event;
    if (!result?.publishedAt) return;

    const post = await strapi.entityService.findOne(
      'api::flightfares-post.flightfares-post',
      result.id,
      { populate: ['categories', 'author', 'coverImage'] },
    );
    if (!post) return;

    const contentHtml = toWordPressHtml(post.content);

    try {
      const directClient = wordpressClient();
      if (directClient) {
        await upsertDirectlyToWordPress(directClient, post, contentHtml);
        return;
      }

      const destination = await strapi.db.query('api::blog-destination.blog-destination').findOne({
        where: { slug: 'flightfares-one', active: true },
      });
      if (!destination?.webhookUrl || !destination?.webhookSecret) return;

      const payload = {
        event: 'article.published',
        article: {
          id: post.documentId || String(post.id), legacyWpId: post.legacyWpId || null,
          title: post.title, slug: post.slug, excerpt: post.excerpt,
          content: contentHtml, contentHtml,
          coverImage: post.coverImage?.url || post.legacyFeaturedImageUrl || null,
          category: post.categories?.[0]?.name || null, tags: [],
          author: post.author?.name || null, publishedAt: post.publishedAt,
          seoTitle: post.seoTitle || null,
          seoDescription: post.seoDescription || null,
          seoKeywords: post.seoKeywords || null,
        },
      };
      const body = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', destination.webhookSecret).update(body).digest('hex');

      await axios.post(destination.webhookUrl, payload, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'X-FXN-Signature': signature },
      });
    } catch (error) {
      strapi.log.error(`[flightfares-post] WordPress sync failed for ${post.slug}: ${error.message}`);
    }
}

module.exports = {
  // Strapi 5 creates the published document row, rather than updating the
  // existing draft row. Keep afterUpdate for edits to already-published posts.
  afterCreate: syncPublishedPost,
  afterUpdate: syncPublishedPost,
};
