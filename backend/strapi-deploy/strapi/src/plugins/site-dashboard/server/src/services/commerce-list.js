'use strict';

/**
 * The catalogue side of a site: products, the categories and brands they use,
 * and the offers attached to them.
 *
 * Posts resolve through the site's `contentTypes` registry, because each site
 * names its own collections. The catalogue does not work that way — every site
 * shares commerce-product, commerce-category and commerce-brand, and belonging
 * is expressed by the product's `site` relation instead.
 *
 * So categories and brands are DERIVED rather than listed: a category belongs to
 * a site when one of that site's products is in it. That was tested against the
 * naming convention the catalogue actually uses — nxtsmarthome's categories are
 * suffixed "AU" — and returns exactly the same seven. Deriving beats matching on
 * the suffix because renaming a category cannot silently drop it from a site,
 * and because nxt.bargains has no such convention to match on at all.
 *
 * Under draft & publish a document is two rows. Live means "a row with
 * published_at exists for this document_id" — the draft row's published_at is
 * null whether or not the document is live, which is the trap that once made
 * every row on the posts screen report as a draft.
 */

const ROLES = {
  products: {
    table: 'commerce_products',
    label: 'products',
    searchFields: ['name', 'slug'],
    draftAndPublish: true,
  },
  categories: {
    table: 'commerce_categories',
    label: 'categories',
    searchFields: ['name', 'slug'],
    draftAndPublish: true,
    derived: true,
  },
  brands: {
    table: 'commerce_brands',
    label: 'brands',
    searchFields: ['name', 'slug'],
    draftAndPublish: true,
    derived: true,
  },
  offers: {
    table: 'commerce_offers',
    label: 'offers',
    searchFields: ['title'],
    draftAndPublish: false,
  },
};

/** Products belonging to one site, as a subquery every other role builds on. */
function siteProducts(knex, slug) {
  return knex({ p: 'commerce_products' })
    .join({ psl: 'commerce_products_site_lnk' }, 'psl.commerce_product_id', 'p.id')
    .join({ st: 'commerce_sites' }, 'st.id', 'psl.commerce_site_id')
    .where('st.slug', slug);
}

function baseQuery(knex, slug, role) {
  switch (role) {
    case 'products':
      return siteProducts(knex, slug).clearSelect().select('p.*');

    case 'categories':
      return knex({ c: 'commerce_categories' })
        .distinct('c.id')
        .select('c.*')
        .join({ pcl: 'commerce_products_categories_lnk' }, 'pcl.commerce_category_id', 'c.id')
        .whereIn('pcl.commerce_product_id', siteProducts(knex, slug).clearSelect().select('p.id'));

    case 'brands':
      return knex({ b: 'commerce_brands' })
        .distinct('b.id')
        .select('b.*')
        .join({ bl: 'commerce_products_brand_ref_lnk' }, 'bl.commerce_brand_id', 'b.id')
        .whereIn('bl.commerce_product_id', siteProducts(knex, slug).clearSelect().select('p.id'));

    case 'offers':
      return knex({ o: 'commerce_offers' })
        .distinct('o.id')
        .select('o.*')
        .join({ opl: 'commerce_offers_product_lnk' }, 'opl.commerce_offer_id', 'o.id')
        .whereIn('opl.commerce_product_id', siteProducts(knex, slug).clearSelect().select('p.id'));

    default:
      return null;
  }
}

/**
 * The hygiene views from the FreshStore screen. Each answers a question worth
 * acting on — a product in no category is unreachable by browsing, one with no
 * offer has nothing to sell — rather than being a filter for its own sake.
 */
function applyTab(knex, query, slug, tab) {
  if (tab === 'no-categories') {
    return query.whereNotExists(
      knex('commerce_products_categories_lnk as x').whereRaw('x.commerce_product_id = p.id'),
    );
  }
  if (tab === 'no-offers') {
    return query.whereNotExists(
      knex('commerce_offers_product_lnk as y').whereRaw('y.commerce_product_id = p.id'),
    );
  }
  return query;
}

/** Table alias each role's query uses, so filters can name the right column. */
function aliasFor(role) {
  return role === 'products' ? 'p' : role === 'categories' ? 'c' : role === 'brands' ? 'b' : 'o';
}

module.exports = ({ strapi }) => ({
  roles: () => Object.keys(ROLES),

  /**
   * Counts for the left rail.
   *
   * Deliberately the same query the list uses, with the same one-row-per-document
   * filter, so the rail can never disagree with the table beneath it.
   */
  async counts(slug) {
    const knex = strapi.db.connection;
    const out = {};
    for (const role of Object.keys(ROLES)) {
      try {
        let q = baseQuery(knex, slug, role);
        if (ROLES[role].draftAndPublish) q = q.whereNull(`${aliasFor(role)}.published_at`);
        const rows = await knex.count({ n: '*' }).from(q.as('sub'));
        out[role] = Number(rows?.[0]?.n ?? 0);
      } catch (error) {
        strapi.log.warn(`[site-dashboard] count ${role} for ${slug}: ${error.message}`);
        out[role] = null;
      }
    }
    return out;
  },

  async list(slug, role, { page = 1, pageSize = 10, q = '', tab = 'all' } = {}) {
    const spec = ROLES[role];
    if (!spec) return { error: `"${role}" is not a catalogue role.` };

    const knex = strapi.db.connection;
    const size = Math.min(100, Math.max(1, Number(pageSize) || 10));
    const current = Math.max(1, Number(page) || 1);

    try {
      let query = baseQuery(knex, slug, role);
      if (!query) return { error: `"${role}" is not a catalogue role.` };

      if (role === 'products') query = applyTab(knex, query, slug, tab);

      // One row per document: draft and published are two rows of the same thing.
      if (spec.draftAndPublish) query = query.whereNull(`${aliasFor(role)}.published_at`);

      if (q) {
        const prefix = aliasFor(role);
        query = query.where((b) => {
          for (const f of spec.searchFields) b.orWhereRaw(`${prefix}.${f} ILIKE ?`, [`%${q}%`]);
        });
      }

      const counted = await knex.count({ n: '*' }).from(query.clone().as('sub'));
      const total = Number(counted?.[0]?.n ?? 0);

      const rows = await query
        .clone()
        .orderBy(`${aliasFor(role)}.updated_at`, 'desc')
        .limit(size)
        .offset((current - 1) * size);

      // Live state, resolved per document rather than per row.
      const ids = rows.map((r) => r.document_id).filter(Boolean);
      const live = new Set();
      if (spec.draftAndPublish && ids.length) {
        const pub = await knex(spec.table).whereIn('document_id', ids).whereNotNull('published_at').select('document_id');
        for (const r of pub) live.add(r.document_id);
      }

      return {
        role,
        tab,
        items: rows.map((r) => ({
          documentId: r.document_id,
          name: r.name ?? r.title ?? '(untitled)',
          slug: r.slug ?? null,
          status: r.product_status ?? r.category_status ?? r.brand_status ?? r.status ?? null,
          published: spec.draftAndPublish ? live.has(r.document_id) : true,
          updatedAt: r.updated_at ?? null,
          uid: `api::${spec.table.replace(/_/g, '-').replace(/s$/, '')}.${spec.table.replace(/_/g, '-').replace(/s$/, '')}`,
        })),
        total,
        page: current,
        pageSize: size,
        pageCount: Math.max(1, Math.ceil(total / size)),
        canPublish: spec.draftAndPublish,
      };
    } catch (error) {
      strapi.log.error(`[site-dashboard] commerce list ${slug}/${role}: ${error.stack || error.message}`);
      return { error: `Could not list ${role}: ${error.message}` };
    }
  },

  /**
   * Publish or unpublish one catalogue document.
   *
   * The document must actually belong to this site. Without that check this is
   * a switch for the whole shared catalogue: commerce-product is used by every
   * property here, so a documentId from another site's products would publish
   * just as happily.
   *
   * Publishing is the only write. Deleting a product is how a real one was
   * destroyed on this project once already - DELETE with a status param removes
   * the whole document, not the published version - so it is not offered here.
   */
  async setPublished(slug, role, documentId, published) {
    const spec = ROLES[role];
    if (!spec) return { error: `"${role}" is not a catalogue role.` };
    if (!spec.draftAndPublish) return { error: `${role} have no published state to change.` };

    const knex = strapi.db.connection;
    const owned = await baseQuery(knex, slug, role)
      .clone()
      .where(`${aliasFor(role)}.document_id`, documentId)
      .first();
    if (!owned) return { error: 'That document does not belong to this site.' };

    const uid = `api::${spec.table.replace(/_/g, '-').replace(/s$/, '')}.${spec.table.replace(/_/g, '-').replace(/s$/, '')}`;
    if (!strapi.contentTypes[uid]) return { error: `Unknown content type ${uid}.` };

    const docs = strapi.documents(uid);
    if (published) await docs.publish({ documentId });
    else await docs.unpublish({ documentId });

    const [live] = await docs.findMany({ filters: { documentId }, status: 'published', limit: 1 });
    return { ok: true, documentId, published: Boolean(live) };
  },
});