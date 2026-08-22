'use strict';

/**
 * Which site is being written for, and where its posts go.
 *
 * AI Writer used to create every draft in api::article.article regardless of
 * which site's dashboard it was opened from. On this CMS that collection
 * belongs to no site, so a post generated for nxtsmarthome.com.au landed
 * somewhere the site does not read and never appeared — while the dashboard
 * tile said "Draft a post for this site".
 *
 * The target is resolved from the same commerce-site `contentTypes` registry
 * the dashboard already uses, so the two cannot disagree about which
 * collection belongs to a site.
 */

const SITE_UID = 'api::commerce-site.commerce-site';

/** Every site that has somewhere to put a post, for the picker. */
async function listSites(strapi) {
  const rows = await strapi.documents(SITE_UID).findMany({
    status: 'draft',
    sort: 'name:asc',
    limit: 100,
  });

  return rows
    .map((s) => ({
      slug: s.slug,
      name: s.name,
      domain: s.domain,
      niche: s.niche || null,
      country: s.country || null,
      hasBrief: Boolean((s.aiWriterBrief || '').trim()),
      target: targetUid(s),
    }))
    .filter((s) => s.slug && s.target);
}

/** The uid of the collection this site's posts live in, or null. */
function targetUid(site) {
  const map = site?.contentTypes && typeof site.contentTypes === 'object' ? site.contentTypes : {};
  const posts = Array.isArray(map.posts) ? map.posts : map.posts ? [map.posts] : [];
  return posts.find((p) => p?.uid)?.uid ?? null;
}

async function resolveSite(strapi, slug) {
  if (!slug) return { error: 'No site given. Open AI Writer from a site in the dashboard.' };

  const [site] = await strapi.documents(SITE_UID).findMany({
    filters: { slug },
    status: 'draft',
    limit: 1,
  });
  if (!site) return { error: `No site with slug "${slug}".` };

  const uid = targetUid(site);
  if (!uid) return { error: `Site "${slug}" has no posts collection in its content map.` };
  if (!strapi.contentTypes[uid]) return { error: `Site "${slug}" points at unknown content type ${uid}.` };

  return { site, uid };
}

/**
 * Only the fields the target actually declares.
 *
 * The post types genuinely disagree: `tags` is json on nxtsmarthome-post and a
 * relation on article, and writing an array into the relation fails the whole
 * create. Anything the target does not declare is dropped rather than guessed.
 */
function pickWritable(strapi, uid, data) {
  const attrs = strapi.contentTypes[uid]?.attributes ?? {};
  const out = {};

  for (const [key, value] of Object.entries(data)) {
    const attr = attrs[key];
    if (!attr || value === undefined || value === null) continue;
    if (attr.type === 'relation' || attr.type === 'media') continue;
    if (attr.type === 'enumeration' && Array.isArray(attr.enum) && !attr.enum.includes(value)) continue;
    if (attr.type === 'json' || Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value;
  }

  return out;
}

module.exports = ({ strapi }) => ({
  listSites: () => listSites(strapi),
  resolveSite: (slug) => resolveSite(strapi, slug),
  targetUid,
  pickWritable: (uid, data) => pickWritable(strapi, uid, data),
});
