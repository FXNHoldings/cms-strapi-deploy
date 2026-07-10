/* eslint-disable no-console */
'use strict';

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

async function findOne(strapi, uid, filters, populate) {
  const rows = await strapi.documents(uid).findMany({
    status: 'published',
    filters,
    populate,
    pagination: { pageSize: 1 },
  });
  return rows[0] ?? null;
}

async function ensureBrand(strapi, sourceBrand) {
  const name = typeof sourceBrand === 'string' ? sourceBrand : sourceBrand?.name;
  if (!name?.trim()) return null;

  const slug = slugify(typeof sourceBrand === 'string' ? sourceBrand : sourceBrand.slug || sourceBrand.name);
  const existing = await findOne(strapi, 'api::commerce-brand.commerce-brand', { slug: { $eq: slug } });
  if (existing) return existing;

  return strapi.documents('api::commerce-brand.commerce-brand').create({
    status: 'published',
    data: {
      name,
      slug,
      description: typeof sourceBrand === 'string' ? undefined : sourceBrand.description,
      websiteUrl: typeof sourceBrand === 'string' ? undefined : sourceBrand.websiteUrl,
      logo: typeof sourceBrand === 'string' ? undefined : sourceBrand.logo?.id,
      order: typeof sourceBrand === 'string' ? 0 : sourceBrand.order ?? 0,
      status: 'active',
    },
  });
}

async function ensureCategory(strapi, sourceCategory, parent) {
  if (!sourceCategory?.name) return null;
  const slug = slugify(sourceCategory.slug || sourceCategory.name);
  const existing = await findOne(strapi, 'api::commerce-category.commerce-category', { slug: { $eq: slug } });

  const data = {
    name: sourceCategory.name,
    slug,
    description: sourceCategory.description,
    order: sourceCategory.order ?? 0,
    icon: sourceCategory.icon,
    image: sourceCategory.image?.id,
    parent: parent?.documentId,
    status: 'active',
  };

  if (existing) {
    return strapi.documents('api::commerce-category.commerce-category').update({
      documentId: existing.documentId,
      status: 'published',
      data,
    });
  }

  return strapi.documents('api::commerce-category.commerce-category').create({
    status: 'published',
    data,
  });
}

async function findCommerceProduct(strapi, product) {
  if (product.asin) {
    const byAsin = await findOne(strapi, 'api::commerce-product.commerce-product', {
      asin: { $eqi: product.asin },
    });
    if (byAsin) return byAsin;
  }

  if (product.gtin) {
    const byGtin = await findOne(strapi, 'api::commerce-product.commerce-product', {
      gtin: { $eqi: product.gtin },
    });
    if (byGtin) return byGtin;
  }

  return findOne(strapi, 'api::commerce-product.commerce-product', {
    slug: { $eq: product.slug },
  });
}

async function main() {
  const strapi = await createStrapi().load();
  const stats = {
    brandsCreatedOrFound: 0,
    categoriesCreatedOrUpdated: 0,
    productsUpdated: 0,
    productsSkipped: 0,
  };

  try {
    const sourceCategories = await strapi.documents('api::bls-product-category.bls-product-category').findMany({
      populate: { parent: true, image: true },
      pagination: { pageSize: 1000 },
    });

    const categoryBySourceDocumentId = new Map();
    const rootCategories = sourceCategories.filter((category) => !category.parent?.documentId);
    const childCategories = sourceCategories.filter((category) => category.parent?.documentId);

    for (const category of rootCategories) {
      const commerceCategory = await ensureCategory(strapi, category);
      if (commerceCategory) {
        categoryBySourceDocumentId.set(category.documentId, commerceCategory);
        stats.categoriesCreatedOrUpdated++;
      }
    }

    for (const category of childCategories) {
      const parent = categoryBySourceDocumentId.get(category.parent.documentId);
      const commerceCategory = await ensureCategory(strapi, category, parent);
      if (commerceCategory) {
        categoryBySourceDocumentId.set(category.documentId, commerceCategory);
        stats.categoriesCreatedOrUpdated++;
      }
    }

    const products = await strapi.documents('api::bls-product.bls-product').findMany({
      populate: {
        brandRef: { populate: { logo: true } },
        categories: true,
      },
      pagination: { pageSize: 1000 },
    });

    for (const product of products) {
      const commerceProduct = await findCommerceProduct(strapi, product);
      if (!commerceProduct) {
        stats.productsSkipped++;
        continue;
      }

      const commerceBrand = await ensureBrand(strapi, product.brandRef ?? product.brand);
      if (commerceBrand) stats.brandsCreatedOrFound++;

      const commerceCategories = [];
      for (const category of product.categories ?? []) {
        let commerceCategory = categoryBySourceDocumentId.get(category.documentId);
        if (!commerceCategory) {
          commerceCategory = await ensureCategory(strapi, category);
          if (commerceCategory) categoryBySourceDocumentId.set(category.documentId, commerceCategory);
        }
        if (commerceCategory) commerceCategories.push(commerceCategory.documentId);
      }

      await strapi.documents('api::commerce-product.commerce-product').update({
        documentId: commerceProduct.documentId,
        status: 'published',
        data: {
          brandRef: commerceBrand?.documentId,
          categories: commerceCategories,
        },
      });
      stats.productsUpdated++;
    }

    console.log(JSON.stringify(stats, null, 2));
  } finally {
    await strapi.destroy().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
