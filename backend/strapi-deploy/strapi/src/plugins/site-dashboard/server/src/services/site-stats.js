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

const CLICK_TABLE = 'affiliate_clicks';
const CLICK_WINDOW_DAYS = 30;

/**
 * Clicks and their estimated value over the last 30 days.
 *
 * Done in SQL rather than through the Document Service because this is an
 * aggregate: counting and summing in the database beats pulling every row into
 * Node to add them up, and this number is rendered on every card.
 *
 * Returns null rather than throwing when the table is absent — it does not
 * exist until the image carrying the content type has been deployed, and the
 * dashboard predates that.
 */
async function clickStats(strapi, siteSlug) {
  const knex = strapi.db.connection;

  try {
    const exists = await knex.schema.hasTable(CLICK_TABLE);
    if (!exists) return null;

    const since = new Date(Date.now() - CLICK_WINDOW_DAYS * 86_400_000);
    const [row] = await knex(CLICK_TABLE)
      .where('site_slug', siteSlug)
      .andWhere('clicked_at', '>=', since)
      .count({ clicks: '*' })
      .sum({ value: 'estimated_value' });

    return {
      windowDays: CLICK_WINDOW_DAYS,
      clicks: Number(row?.clicks ?? 0),
      estimatedValue: row?.value == null ? null : Number(row.value),
    };
  } catch (error) {
    strapi.log.warn(`[site-dashboard] click stats unavailable for ${siteSlug}: ${error.message}`);
    return null;
  }
}

/**
 * Offer health for a site, or null when it has none to speak of.
 *
 * Offers reach a site only through their product's `site` relation, and just
 * 410 of 1,532 products carry one — so 1,177 of 1,934 offers cannot be
 * attributed to anywhere. Returning null for a site with no attributed offers
 * is deliberate: a card reading "0 broken" would claim a clean bill of health
 * for a site nothing has ever checked.
 *
 * Counts distinct offers against the *published* product row. The link table
 * holds both draft and published versions, and joining naively double-counts
 * every offer exactly twice.
 */
async function offerHealth(strapi, siteSlug) {
  const knex = strapi.db.connection;

  try {
    if (!(await knex.schema.hasTable('commerce_offers'))) return null;

    const rows = await knex
      .select('o.status')
      .countDistinct({ n: 'o.id' })
      .from({ o: 'commerce_offers' })
      .join({ opl: 'commerce_offers_product_lnk' }, 'opl.commerce_offer_id', 'o.id')
      .join({ p: 'commerce_products' }, function () {
        this.on('p.id', 'opl.commerce_product_id').andOnNotNull('p.published_at');
      })
      .join({ psl: 'commerce_products_site_lnk' }, 'psl.commerce_product_id', 'p.id')
      .join({ s: 'commerce_sites' }, 's.id', 'psl.commerce_site_id')
      .where('s.slug', siteSlug)
      .groupBy('o.status');

    if (!rows.length) return null;

    const byStatus = {};
    let total = 0;
    for (const row of rows) {
      const n = Number(row.n ?? 0);
      byStatus[row.status ?? 'unknown'] = n;
      total += n;
    }

    const [checked] = await knex({ o: 'commerce_offers' })
      .countDistinct({ n: 'o.id' })
      .join({ opl: 'commerce_offers_product_lnk' }, 'opl.commerce_offer_id', 'o.id')
      .join({ p: 'commerce_products' }, function () {
        this.on('p.id', 'opl.commerce_product_id').andOnNotNull('p.published_at');
      })
      .join({ psl: 'commerce_products_site_lnk' }, 'psl.commerce_product_id', 'p.id')
      .join({ s: 'commerce_sites' }, 's.id', 'psl.commerce_site_id')
      .where('s.slug', siteSlug)
      .whereNotNull('o.last_link_check_at');

    return {
      total,
      active: byStatus.active ?? 0,
      broken: (byStatus.expired ?? 0) + (byStatus.error ?? 0),
      stale: byStatus.stale ?? 0,
      everChecked: Number(checked?.n ?? 0),
    };
  } catch (error) {
    strapi.log.warn(`[site-dashboard] offer health unavailable for ${siteSlug}: ${error.message}`);
    return null;
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
    clicks: await clickStats(strapi, site.slug),
    offers: await offerHealth(strapi, site.slug),
    warnings,
  };
}

/**
 * Most recent content across a role's sources, newest first.
 *
 * Deliberately fetches whole documents rather than naming `fields`: the six
 * post types do not agree on their shape, and asking for a column one of them
 * lacks fails the whole query. Eight rows of overfetch is the cheaper mistake.
 */
async function recentDocuments(strapi, sources, limit = 8) {
  const rows = [];

  for (const source of sources) {
    if (!source?.uid || !strapi.contentTypes[source.uid]) continue;
    const filters = source.filter && Object.keys(source.filter).length ? source.filter : undefined;

    try {
      const docs = await strapi.documents(source.uid).findMany({
        ...(filters ? { filters } : {}),
        status: 'draft',
        sort: 'updatedAt:desc',
        limit,
      });

      for (const doc of docs) {
        rows.push({
          uid: source.uid,
          documentId: doc.documentId,
          title: doc.title ?? doc.name ?? '(untitled)',
          updatedAt: doc.updatedAt ?? null,
          publishedAt: doc.publishedAt ?? null,
        });
      }
    } catch {
      // countSource already reports why this source is unreadable; no need to
      // fail the whole page over its recent list too.
    }
  }

  return rows
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, limit);
}

module.exports = ({ strapi }) => ({
  async detail(slug) {
    const [site] = await strapi.documents(SITE_UID).findMany({
      filters: { slug },
      status: 'draft',
      populate: { thumbnail: true },
      limit: 1,
    });
    if (!site) return null;

    const stats = await statsForSite(strapi, site);
    const raw = site.contentTypes?.posts ?? [];
    stats.recentPosts = await recentDocuments(strapi, Array.isArray(raw) ? raw : [raw]);
    return stats;
  },

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
