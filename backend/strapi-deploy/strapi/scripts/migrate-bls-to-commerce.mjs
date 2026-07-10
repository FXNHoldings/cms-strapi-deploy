/* eslint-disable no-console */
'use strict';

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

const MERCHANTS = {
  amazon: { name: 'Amazon', slug: 'amazon', websiteUrl: 'https://www.amazon.com', country: 'US' },
  'amazon-uk': { name: 'Amazon UK', slug: 'amazon-uk', websiteUrl: 'https://www.amazon.co.uk', country: 'GB' },
  'amazon-au': { name: 'Amazon Australia', slug: 'amazon-au', websiteUrl: 'https://www.amazon.com.au', country: 'AU' },
  ebay: { name: 'eBay', slug: 'ebay', websiteUrl: 'https://www.ebay.com', country: 'US' },
  walmart: { name: 'Walmart', slug: 'walmart', websiteUrl: 'https://www.walmart.com', country: 'US' },
  target: { name: 'Target', slug: 'target', websiteUrl: 'https://www.target.com', country: 'US' },
  sephora: { name: 'Sephora', slug: 'sephora', websiteUrl: 'https://www.sephora.com', country: 'US' },
  ulta: { name: 'Ulta Beauty', slug: 'ulta', websiteUrl: 'https://www.ulta.com', country: 'US' },
  manufacturer: { name: 'Manufacturer', slug: 'manufacturer', country: 'US' },
  other: { name: 'Other merchant', slug: 'other' },
};

const SOURCE_SITE = {
  name: 'BestLooking.Skin',
  slug: 'bestlooking-skin',
  domain: 'bestlooking.skin',
  niche: 'Skincare',
  country: 'US',
  currency: 'USD',
};

function ids(items) {
  return (items ?? []).map((item) => item?.id).filter(Boolean);
}

function cleanSlug(slug, fallback) {
  return String(slug || fallback || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function merchantConfig(slug) {
  return MERCHANTS[slug] ?? {
    name: slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : 'Other merchant',
    slug: slug || 'other',
  };
}

async function findFirst(strapi, uid, filters, populate) {
  const rows = await strapi.documents(uid).findMany({
    filters,
    populate,
    status: 'published',
    pagination: { pageSize: 1 },
  });
  return rows?.[0] ?? null;
}

async function ensureMerchant(strapi, slug) {
  const config = merchantConfig(slug);
  const existing = await findFirst(strapi, 'api::commerce-merchant.commerce-merchant', {
    slug: { $eq: config.slug },
  });
  if (existing) return existing;

  return strapi.documents('api::commerce-merchant.commerce-merchant').create({
    status: 'published',
    data: {
      name: config.name,
      slug: config.slug,
      websiteUrl: config.websiteUrl,
      country: config.country,
      status: 'active',
    },
  });
}

async function ensureSite(strapi) {
  const existing = await findFirst(strapi, 'api::commerce-site.commerce-site', {
    slug: { $eq: SOURCE_SITE.slug },
  });
  if (existing) return existing;

  return strapi.documents('api::commerce-site.commerce-site').create({
    status: 'published',
    data: {
      ...SOURCE_SITE,
      enabledCategories: ['skincare', 'beauty'],
      status: 'active',
    },
  });
}

async function findExistingProduct(strapi, product) {
  if (product.asin) {
    const byAsin = await findFirst(strapi, 'api::commerce-product.commerce-product', {
      asin: { $eqi: product.asin },
    });
    if (byAsin) return byAsin;
  }

  if (product.gtin) {
    const byGtin = await findFirst(strapi, 'api::commerce-product.commerce-product', {
      gtin: { $eqi: product.gtin },
    });
    if (byGtin) return byGtin;
  }

  return findFirst(strapi, 'api::commerce-product.commerce-product', {
    slug: { $eq: product.slug },
  });
}

function productData(product) {
  const categoryNames = (product.categories ?? []).map((category) => category.name).filter(Boolean);
  const categorySlugs = (product.categories ?? []).map((category) => category.slug).filter(Boolean);
  const brand = product.brandRef?.name ?? product.brand;

  return {
    name: product.name,
    slug: cleanSlug(product.slug, product.name),
    brand,
    shortDescription: product.shortDescription,
    description: product.description,
    primaryImage: product.primaryImage?.id,
    gallery: ids(product.gallery),
    category: categoryNames[0] ?? 'Skincare',
    tags: [
      'bestlooking-skin',
      ...categorySlugs,
      ...(Array.isArray(product.skinTypes) ? product.skinTypes : []),
    ].filter(Boolean),
    specs: {
      source: 'bestlooking-skin',
      sourceDocumentId: product.documentId,
      sourceProductId: product.id,
      keyFeatures: product.keyFeatures ?? [],
      skinTypes: product.skinTypes ?? [],
      ingredients: product.ingredients,
      categories: categoryNames,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      seoKeywords: product.seoKeywords,
      sourceUrl: product.sourceUrl,
      primaryAffiliateUrl: product.primaryAffiliateUrl,
    },
    asin: product.asin,
    gtin: product.gtin,
    mpn: product.skuOrModel,
    sku: product.skuOrModel,
    rating: product.rating,
    ratingCount: product.ratingCount ?? 0,
    status: product.available === false ? 'archived' : 'active',
  };
}

async function upsertProduct(strapi, product) {
  const existing = await findExistingProduct(strapi, product);
  const data = productData(product);

  if (existing) {
    return {
      item: existing,
      created: false,
    };
  }

  return {
    item: await strapi.documents('api::commerce-product.commerce-product').create({
      status: 'published',
      data,
    }),
    created: true,
  };
}

function offerKey(offer) {
  return [
    offer.product?.documentId ?? offer.product?.id,
    offer.merchant?.documentId ?? offer.merchant?.id,
    offer.productUrl || offer.affiliateUrl || offer.merchantSku || '',
  ].join('|');
}

async function findExistingOffer(strapi, product, merchant, url, sku) {
  const filters = url
    ? { $or: [{ productUrl: { $eq: url } }, { affiliateUrl: { $eq: url } }] }
    : { merchantSku: { $eq: sku } };

  const candidates = await strapi.documents('api::commerce-offer.commerce-offer').findMany({
    filters,
    populate: { product: true, merchant: true },
    pagination: { pageSize: 100 },
  });
  return candidates.find((offer) => {
    if (url && (offer.productUrl === url || offer.affiliateUrl === url)) return true;
    if (sku && offer.merchantSku === sku) return true;
    return false;
  }) ?? null;
}

async function upsertOffer(strapi, sourceProduct, commerceProduct, merchantSlug, payload) {
  if (!payload.productUrl && !payload.affiliateUrl) return { skipped: true };
  const merchant = await ensureMerchant(strapi, merchantSlug);
  const productUrl = payload.productUrl ?? payload.affiliateUrl;
  const existing = await findExistingOffer(strapi, commerceProduct, merchant, productUrl, payload.merchantSku);
  const data = {
    product: commerceProduct.documentId,
    merchant: merchant.documentId,
    title: payload.title ?? sourceProduct.name,
    price: payload.price,
    originalPrice: payload.originalPrice,
    currency: payload.currency ?? sourceProduct.currency ?? 'USD',
    discountPercent: payload.discountPercent,
    productUrl,
    affiliateUrl: payload.affiliateUrl,
    couponCode: payload.couponCode,
    availability: payload.available === false ? 'out_of_stock' : 'in_stock',
    shippingCost: payload.shippingCost,
    condition: payload.condition ?? 'new',
    merchantSku: payload.merchantSku,
    source: payload.source ?? 'bestlooking-skin-migration',
    lastCheckedAt: payload.lastCheckedAt ?? sourceProduct.lastPriceSyncAt,
    status: payload.available === false ? 'expired' : 'active',
  };

  if (existing) {
    return {
      item: await strapi.documents('api::commerce-offer.commerce-offer').update({
        documentId: existing.documentId,
        data,
      }),
      created: false,
    };
  }

  return {
    item: await strapi.documents('api::commerce-offer.commerce-offer').create({ data }),
    created: true,
  };
}

function offerPayloads(product) {
  const payloads = [];
  if (product.sourceUrl || product.primaryAffiliateUrl || product.currentPrice) {
    payloads.push({
      merchant: product.sourceMerchant ?? 'amazon',
      price: product.currentPrice,
      originalPrice: product.originalPrice,
      currency: product.currency,
      productUrl: product.sourceUrl ?? product.primaryAffiliateUrl,
      affiliateUrl: product.primaryAffiliateUrl,
      merchantSku: product.asin,
      available: product.available,
      lastCheckedAt: product.lastPriceSyncAt,
      source: 'bestlooking-skin-product',
    });
  }
  if (product.walmartUrl || product.walmartPrice) {
    payloads.push({
      merchant: 'walmart',
      price: product.walmartPrice,
      currency: product.currency,
      productUrl: product.walmartUrl,
      affiliateUrl: product.walmartUrl,
      available: product.walmartPrice != null,
      lastCheckedAt: product.walmartLastSyncAt,
      source: 'bestlooking-skin-walmart',
    });
  }
  if (product.ebayUrl || product.ebayPrice) {
    payloads.push({
      merchant: 'ebay',
      price: product.ebayPrice,
      currency: product.currency,
      productUrl: product.ebayUrl,
      affiliateUrl: product.ebayUrl,
      available: product.ebayPrice != null,
      lastCheckedAt: product.ebayLastSyncAt,
      source: 'bestlooking-skin-ebay',
    });
  }
  return payloads;
}

async function migrateSnapshots(strapi, productMap, offerMap) {
  const snapshots = await strapi.documents('api::bls-price-snapshot.bls-price-snapshot').findMany({
    populate: { product: true },
    pagination: { pageSize: 1000 },
  });
  let created = 0;
  let skipped = 0;

  for (const snapshot of snapshots) {
    const commerceProduct = productMap.get(snapshot.product?.documentId);
    if (!commerceProduct) {
      skipped++;
      continue;
    }

    const merchant = await ensureMerchant(strapi, snapshot.merchant ?? 'other');
    const checkedAt = snapshot.recordedAt;
    const source = `bestlooking-skin-${snapshot.source ?? 'snapshot'}`;
    const existing = await strapi.documents('api::commerce-price-snapshot.commerce-price-snapshot').findMany({
      filters: {
        checkedAt: { $eq: checkedAt },
        price: { $eq: snapshot.price },
        source: { $eq: source },
      },
      pagination: { pageSize: 1 },
    });

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const linkedOffer = offerMap.get(`${commerceProduct.documentId}|${merchant.documentId}`);
    await strapi.documents('api::commerce-price-snapshot.commerce-price-snapshot').create({
      data: {
        product: commerceProduct.documentId,
        merchant: merchant.documentId,
        offer: linkedOffer?.documentId,
        price: snapshot.price,
        currency: snapshot.currency ?? 'USD',
        availability: snapshot.available === false ? 'out_of_stock' : 'in_stock',
        checkedAt,
        source,
        rawPayload: {
          sourceDocumentId: snapshot.documentId,
          sourceSnapshotId: snapshot.id,
        },
      },
    });
    created++;
  }

  return { created, skipped };
}

async function main() {
  const strapi = await createStrapi().load();
  const productMap = new Map();
  const offerMap = new Map();
  const stats = {
    productsCreated: 0,
    productsUpdated: 0,
    offersCreated: 0,
    offersUpdated: 0,
    offersSkipped: 0,
  };

  try {
    await ensureSite(strapi);

    const products = await strapi.documents('api::bls-product.bls-product').findMany({
      populate: {
        primaryImage: true,
        gallery: true,
        brandRef: true,
        categories: true,
      },
      pagination: { pageSize: 1000 },
    });

    for (const sourceProduct of products) {
      const { item: commerceProduct, created } = await upsertProduct(strapi, sourceProduct);
      productMap.set(sourceProduct.documentId, commerceProduct);
      if (created) stats.productsCreated++;
      else stats.productsUpdated++;

      for (const payload of offerPayloads(sourceProduct)) {
        const result = await upsertOffer(
          strapi,
          sourceProduct,
          commerceProduct,
          payload.merchant,
          payload,
        );

        if (result.skipped) {
          stats.offersSkipped++;
          continue;
        }

        const offer = result.item;
        const merchant = offer.merchant ?? await ensureMerchant(strapi, payload.merchant);
        offerMap.set(`${commerceProduct.documentId}|${merchant.documentId}`, offer);
        if (result.created) stats.offersCreated++;
        else stats.offersUpdated++;
      }
    }

    const snapshotStats = await migrateSnapshots(strapi, productMap, offerMap);

    console.log(JSON.stringify({ ...stats, snapshotsCreated: snapshotStats.created, snapshotsSkipped: snapshotStats.skipped }, null, 2));
  } finally {
    await strapi.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
