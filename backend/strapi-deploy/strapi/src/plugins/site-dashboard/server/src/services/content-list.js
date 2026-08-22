'use strict';

/**
 * Paginated, searchable listing for one role of one site — and the publish
 * toggle that goes with it.
 *
 * Everything here resolves through the site's `contentTypes` registry rather
 * than taking a uid from the caller. That is not tidiness: the publish
 * endpoint would otherwise let anyone who can reach the admin API publish any
 * document of any type by naming it, and a dashboard scoped to one site would
 * quietly be a switch for the whole CMS. A uid that is not in this site's map
 * for this role is refused.
 *
 * A role can have more than one source (nxtsmarthome.com.au draws posts from
 * two collections), so listing merges them. Merging costs an overfetch — each
 * source is asked for enough rows to cover the requested page — which is fine
 * at these sizes and wrong at ten times them. The alternative is a union query
 * the Document Service cannot express.
 */

const SITE_UID = 'api::commerce-site.commerce-site';

/** The registry's sources for one role, normalised to an array. */
async function sourcesFor(strapi, slug, role) {
  const [site] = await strapi.documents(SITE_UID).findMany({
    filters: { slug },
    status: 'draft',
    limit: 1,
  });
  if (!site) return { error: `No site with slug "${slug}".` };

  const map = site.contentTypes && typeof site.contentTypes === 'object' ? site.contentTypes : {};
  const raw = map[role];
  if (!raw) return { error: `Site "${slug}" has no "${role}" in its content map.` };

  const sources = (Array.isArray(raw) ? raw : [raw]).filter((s) => s?.uid && strapi.contentTypes[s.uid]);
  if (!sources.length) return { error: `No readable content type for "${role}" on "${slug}".` };
  return { site, sources };
}

/**
 * A search filter the type can actually answer.
 *
 * The six post types do not agree on their shape, and filtering on a field one
 * of them lacks fails the whole query rather than returning nothing — so the
 * field is chosen per type from what it actually declares.
 */
function searchFilter(strapi, uid, q) {
  if (!q) return null;
  const attrs = strapi.contentTypes[uid]?.attributes ?? {};
  const fields = ['title', 'name', 'slug'].filter((f) => attrs[f]?.type === 'string' || attrs[f]?.type === 'uid');
  if (!fields.length) return null;
  return { $or: fields.map((f) => ({ [f]: { $containsi: q } })) };
}

function rowFrom(uid, doc) {
  return {
    uid,
    documentId: doc.documentId,
    title: doc.title ?? doc.name ?? '(untitled)',
    slug: doc.slug ?? null,
    publishedAt: null, // resolved by resolvePublished - see the note there
    updatedAt: doc.updatedAt ?? null,
  };
}

/**
 * Fill in publish state for a page of rows.
 *
 * Under draft & publish a document is two rows, and the DRAFT row's
 * publishedAt is null whether or not the document is live - the timestamp
 * lives on the published row. Listing drafts (which is the only way to see
 * every document, published or not) and reading publishedAt off them therefore
 * reports everything as a draft, always. The state has to come from asking
 * whether a published row exists at all.
 *
 * One query per content type per page, not per row.
 */
async function resolvePublished(strapi, rows) {
  const byUid = new Map();
  for (const r of rows) {
    if (!byUid.has(r.uid)) byUid.set(r.uid, []);
    byUid.get(r.uid).push(r.documentId);
  }

  for (const [uid, ids] of byUid) {
    // A type without draft & publish has no unpublished state to be in.
    if (strapi.contentTypes[uid]?.options?.draftAndPublish !== true) {
      for (const r of rows) if (r.uid === uid) r.publishedAt = r.updatedAt;
      continue;
    }
    try {
      const live = await strapi.documents(uid).findMany({
        filters: { documentId: { $in: ids } },
        status: 'published',
        limit: ids.length,
      });
      const stamps = new Map(live.map((d) => [d.documentId, d.publishedAt ?? null]));
      for (const r of rows) {
        if (r.uid === uid && stamps.has(r.documentId)) r.publishedAt = stamps.get(r.documentId);
      }
    } catch (error) {
      strapi.log.warn(`[site-dashboard] publish state for ${uid}: ${error.message}`);
    }
  }
  return rows;
}

module.exports = ({ strapi }) => ({
  async list(slug, role, { page = 1, pageSize = 10, q = '' } = {}) {
    const resolved = await sourcesFor(strapi, slug, role);
    if (resolved.error) return resolved;

    const size = Math.min(100, Math.max(1, Number(pageSize) || 10));
    const current = Math.max(1, Number(page) || 1);
    const reach = current * size; // enough from each source to cover this page

    let total = 0;
    const rows = [];

    for (const source of resolved.sources) {
      const filters = {
        ...(source.filter && Object.keys(source.filter).length ? source.filter : {}),
        ...(searchFilter(strapi, source.uid, q) ?? {}),
      };
      const base = Object.keys(filters).length ? { filters } : {};

      try {
        const docs = strapi.documents(source.uid);
        // status:'draft' is every document, published or not — the draft
        // version always exists, so this is the full list, not the unpublished one.
        const [count, page1] = await Promise.all([
          docs.count({ ...base, status: 'draft' }),
          docs.findMany({ ...base, status: 'draft', sort: 'updatedAt:desc', limit: reach }),
        ]);
        total += count;
        for (const doc of page1) rows.push(rowFrom(source.uid, doc));
      } catch (error) {
        strapi.log.warn(`[site-dashboard] list ${source.uid}: ${error.message}`);
      }
    }

    rows.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    const items = await resolvePublished(strapi, rows.slice((current - 1) * size, current * size));

    return {
      role,
      items,
      total,
      page: current,
      pageSize: size,
      pageCount: Math.max(1, Math.ceil(total / size)),
      multiSource: resolved.sources.length > 1,
    };
  },

  /**
   * Publish or unpublish one document.
   *
   * The uid must be one this site actually claims for this role — see the note
   * at the top. Publishing is reversible, which is why it is the only write
   * this dashboard offers; deleting is not, and belongs in the Content Manager
   * where it comes with its own confirmation.
   */
  async setPublished(slug, role, uid, documentId, published) {
    const resolved = await sourcesFor(strapi, slug, role);
    if (resolved.error) return resolved;

    if (!resolved.sources.some((s) => s.uid === uid)) {
      return { error: `"${uid}" is not a ${role} source for ${slug}.` };
    }
    if (strapi.contentTypes[uid]?.options?.draftAndPublish !== true) {
      return { error: `${uid} has no draft/publish state to change.` };
    }

    const docs = strapi.documents(uid);
    const [existing] = await docs.findMany({ filters: { documentId }, status: 'draft', limit: 1 });
    if (!existing) return { error: 'No such document on this site.' };

    if (published) await docs.publish({ documentId });
    else await docs.unpublish({ documentId });

    // Read the PUBLISHED row: the draft's publishedAt is null either way.
    const [live] = await docs.findMany({ filters: { documentId }, status: 'published', limit: 1 });
    return { ok: true, documentId, publishedAt: live?.publishedAt ?? null, published: Boolean(live) };
  },
});
