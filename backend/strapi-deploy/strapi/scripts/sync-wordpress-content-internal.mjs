/* eslint-disable no-console */
'use strict';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');
process.env.STRAPI_SKIP_POLLERS = '1';

const onlySite = process.env.SITE || '';
const sites = [
  {
    key: 'flightfares', wp: 'https://flightfares.one/wp-json/wp/v2',
    categoryUid: 'api::flightfares-category.flightfares-category',
    authorUid: 'api::flightfares-author.flightfares-author',
    postUid: 'api::flightfares-post.flightfares-post', fullPost: true,
  },
  {
    key: 'globalscholar', wp: 'https://globalscholar.one/wp-json/wp/v2',
    categoryUid: 'api::globalscholar-category.globalscholar-category',
    authorUid: 'api::globalscholar-author.globalscholar-author',
    postUid: 'api::globalscholar-post.globalscholar-post', fullPost: true,
  },
  {
    key: 'bestlooking', wp: 'https://bestlooking.skin/wp-json/wp/v2',
    categoryUid: 'api::bls-category.bls-category',
    authorUid: 'api::bls-author.bls-author',
    postUid: 'api::bls-post.bls-post', fullPost: false,
  },
].filter((site) => !onlySite || site.key === onlySite);

async function allWp(base, type) {
  const rows = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${base}/${type}?per_page=100&page=${page}&context=view`);
    if (response.status === 400) break;
    if (!response.ok) throw new Error(`${base}/${type} page ${page}: HTTP ${response.status}`);
    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

function plain(html = '') {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

async function upsert(strapi, uid, legacyWpId, data) {
  const existing = await strapi.db.query(uid).findOne({ where: { legacyWpId } });
  if (existing) {
    return strapi.entityService.update(uid, existing.id, { data });
  }
  return strapi.entityService.create(uid, { data });
}

async function syncSite(strapi, site) {
  console.log(`\n${site.key}: fetching WordPress`);
  const [categories, authors, posts] = await Promise.all([
    allWp(site.wp, 'categories'), allWp(site.wp, 'users'), allWp(site.wp, 'posts'),
  ]);

  const categoryIds = new Map();
  for (const category of categories) {
    const saved = await upsert(strapi, site.categoryUid, category.id, {
      name: plain(category.name), slug: category.slug,
      description: plain(category.description), legacyWpId: category.id,
    });
    categoryIds.set(category.id, saved.id);
  }
  for (const category of categories.filter((item) => item.parent)) {
    await upsert(strapi, site.categoryUid, category.id, {
      parent: categoryIds.get(category.parent) || null,
    });
  }

  const authorIds = new Map();
  for (const author of authors) {
    const saved = await upsert(strapi, site.authorUid, author.id, {
      name: plain(author.name), slug: author.slug, bio: plain(author.description),
      legacyWpId: author.id,
      avatarUrl: author.avatar_urls?.['96'] || author.avatar_urls?.['48'] || null,
    });
    authorIds.set(author.id, saved.id);
  }

  for (const post of posts) {
    const relationData = {
      categories: (post.categories || []).map((id) => categoryIds.get(id)).filter(Boolean),
      author: authorIds.get(post.author) || null,
    };
    const data = site.fullPost ? {
      title: plain(post.title?.rendered), slug: post.slug,
      excerpt: plain(post.excerpt?.rendered).slice(0, 1000),
      content: post.content?.rendered || '<p></p>', sourceUrl: post.link,
      legacyWpId: post.id, source: 'wp-import',
      legacyFeaturedImageUrl: post._links?.['wp:featuredmedia']?.[0]?.href || null,
      publishedAt: post.status === 'publish' && post.date_gmt ? `${post.date_gmt}.000Z` : null,
      ...relationData,
    } : relationData;
    await upsert(strapi, site.postUid, post.id, data);
  }

  console.log(`${site.key}: ${categories.length} categories, ${authors.length} authors, ${posts.length} posts synced`);
}

const strapi = await createStrapi().load();
strapi.log.level = 'error';
try {
  for (const site of sites) await syncSite(strapi, site);
} finally {
  await strapi.destroy();
}
process.exit(0);
