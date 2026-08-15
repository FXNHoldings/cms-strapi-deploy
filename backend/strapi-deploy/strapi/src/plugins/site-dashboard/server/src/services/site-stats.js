'use strict';

/**
 * Turns each commerce-site's `contentTypes` map into real numbers.
 *
 * The map keys a role ("posts", "categories") to an array of sources, because a
 * role can have more than one. nxtsmarthome.com.au is why: its markdown-sourced
 * posts live in nxtsmarthome-post, and it also shares nxtsmart-post with
 * nxtsmart.homes, split by that type's own `site` enum. A source may therefore
 * carry a `filter`, and dropping it makes each of those two sites report the
 * other's rows as its own.
 *
 * Everything here degrades rather than throws. A registry pointing at a content
 * type that no longer exists is a real possibility on this CMS — six gatsby
 * types were removed once already — and one stale uid should cost you that
 * one number, not the whole dashboard.
 */

const SITE_UID = 'api::commerce-site.commerce-site';

function hasDraftAndPublish(strapi, uid) {
  return strapi.contentTypes[uid]?.options?.draftAndPublish === true;
}

/** Counts for one source. Never throws — failures come back as `error`. */
async function countSource(strapi, source) {
  const uid = source?.uid;
  if (!uid) return { uid: null, error: 'source has no uid' };

  if (!strapi.contentTypes[uid]) {
    return { uid, error: 'content type not found' };
  }

  const filters = source.filter && Object.keys(source.filter).length ? source.filter : undefined;
  const base = filters ? { filters } : {};

  try {
    const docs = strapi.documents(uid);

    if (!hasDraftAndPublish(strapi, uid)) {
      const total = await docs.count(base);
      return { uid, filter: filters ?? null, total, published: total, drafts: 0, draftAndPublish: false };
    }

    // `status: 'draft'` is every document, published or not — the draft version
    // always exists. Unpublished is therefore the difference, not its own query.
    const [total, published] = await Promise.all([
      docs.count({ ...base, status: 'draft' }),
      docs.count({ ...base, status: 'published' }),
    ]);

    let lastPublishedAt = null;
    if (published > 0) {
      const [latest] = await docs.findMany({
        ...base,
        status: 'published',
        fields: ['publishedAt'],
        sort: 'publishedAt:desc',
        limit: 1,
      });
      lastPublishedAt = latest?.publishedAt ?? null;
    }

    return {
      uid,
      filter: filters ?? null,
      total,
      published,
      drafts: Math.max(0, total - published),
      lastPublishedAt,
      draftAndPublish: true,
    };
  } catch (error) {
    return { uid, filter: filters ?? null, error: error.message };
  }
}

async function statsForSite(strapi, site) {
  const map = site.contentTypes && typeof site.contentTypes === 'object' ? site.contentTypes : {};
  const roles = {};
  const warnings = [];

  for (const [role, rawSources] of Object.entries(map)) {
    const sources = Array.isArray(rawSources) ? rawSources : [rawSources];
    const counted = await Promise.all(sources.map((s) => countSource(strapi, s)));

    for (const c of counted) {
      if (c.error) warnings.push(`${role}: ${c.uid ?? 'unknown'} — ${c.error}`);
    }

    const ok = counted.filter((c) => !c.error);
    const lastPublishedAt = ok
      .map((c) => c.lastPublishedAt)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    roles[role] = {
      total: ok.reduce((n, c) => n + (c.total ?? 0), 0),
      published: ok.reduce((n, c) => n + (c.published ?? 0), 0),
      drafts: ok.reduce((n, c) => n + (c.drafts ?? 0), 0),
      lastPublishedAt,
      sources: counted,
    };
  }

  if (!Object.keys(map).length) {
    warnings.push('No contentTypes map set — this site has nothing to count yet.');
  }

  return {
    documentId: site.documentId,
    name: site.name,
    slug: site.slug,
    domain: site.domain,
    niche: site.niche ?? null,
    country: site.country ?? null,
    currency: site.currency ?? null,
    siteStatus: site.siteStatus ?? null,
    repoPath: site.repoPath ?? null,
    deployCommand: site.deployCommand ?? null,
    gaMeasurementId: site.gaMeasurementId ?? null,
    thumbnailUrl: site.thumbnail?.url ?? null,
    isPublished: Boolean(site.publishedAt),
    roles,
    warnings,
  };
}

module.exports = ({ strapi }) => ({
  async list() {
    // Read the draft version: it exists for every row, so a site added but not
    // yet published still appears here rather than silently missing from the
    // dashboard. `isPublished` carries that distinction to the UI.
    const sites = await strapi.documents(SITE_UID).findMany({
      status: 'draft',
      populate: { thumbnail: true },
      sort: 'name:asc',
      limit: 100,
    });

    return Promise.all(sites.map((site) => statsForSite(strapi, site)));
  },
});
