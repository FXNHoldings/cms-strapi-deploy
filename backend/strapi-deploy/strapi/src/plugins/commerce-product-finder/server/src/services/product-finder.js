'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const slugifyLib = require('slugify');

const PRODUCT_UID = 'api::commerce-product.commerce-product';
const MERCHANT_UID = 'api::commerce-merchant.commerce-merchant';
const OFFER_UID = 'api::commerce-offer.commerce-offer';
const SNAPSHOT_UID = 'api::commerce-price-snapshot.commerce-price-snapshot';
const BRAND_UID = 'api::commerce-brand.commerce-brand';
const CATEGORY_UID = 'api::commerce-category.commerce-category';
const NXT_POST_UID = 'api::nxt-post.nxt-post';

module.exports = ({ strapi }) => ({
  async merchants() {
    const merchants = await strapi.documents(MERCHANT_UID).findMany({
      status: 'published',
      filters: { status: { $eq: 'active' } },
      sort: ['name:asc'],
      pagination: { pageSize: 200 },
    });

    return merchants.map((merchant) => ({
      id: merchant.id,
      documentId: merchant.documentId,
      name: merchant.name,
      slug: merchant.slug,
      websiteUrl: merchant.websiteUrl,
    }));
  },

  async search(params = {}) {
    const q = clean(params.q);
    const merchantSlug = clean(params.merchantSlug);
    if (!q || q.length < 2) return { results: [] };

    const products = await strapi.documents(PRODUCT_UID).findMany({
      status: 'published',
      filters: {
        $or: [
          { name: { $containsi: q } },
          { brand: { $containsi: q } },
          { category: { $containsi: q } },
          { asin: { $containsi: q } },
          { gtin: { $containsi: q } },
          { mpn: { $containsi: q } },
          { sku: { $containsi: q } },
        ],
      },
      populate: {
        primaryImage: true,
        brandRef: true,
        categories: true,
        offers: { populate: { merchant: true } },
      },
      sort: ['updatedAt:desc'],
      pagination: { pageSize: 25 },
    });

    const filtered = merchantSlug
      ? products.filter((product) => (product.offers || []).some((offer) => offer.merchant?.slug === merchantSlug))
      : products;

    return {
      results: filtered.map(formatProductResult),
    };
  },

  async previewUrl(rawUrl) {
    const url = normalizeUrl(rawUrl);
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; NXT.Bargains Product Finder/1.0)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`Could not preview URL. HTTP ${response.status}`);
    }

    const html = await response.text();
    const meta = extractMeta(html);
    const title = first(meta['og:title'], meta['twitter:title'], extractTitle(html));
    const description = first(meta['og:description'], meta.description, meta['twitter:description']);
    const imageUrl = absolutize(first(meta['og:image'], meta['twitter:image'], meta.image), url);
    const amount = first(
      meta['product:price:amount'],
      meta['og:price:amount'],
      jsonLdValue(html, ['offers', 'price']),
    );
    const currency = first(
      meta['product:price:currency'],
      meta['og:price:currency'],
      jsonLdValue(html, ['offers', 'priceCurrency']),
    );
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const merchant = await findMerchantByHost(strapi, hostname);

    return {
      productName: clean(title),
      shortDescription: clean(description),
      productUrl: url,
      affiliateUrl: url,
      imageUrl,
      price: number(amount),
      currency: currency || 'USD',
      merchantSlug: merchant?.slug || slugify(hostname.split('.')[0]),
      merchantName: merchant?.name || hostToName(hostname),
      merchantWebsite: merchant?.websiteUrl || `https://${hostname}`,
      source: 'url-preview',
    };
  },

  async save(payload) {
    const merchant = await ensureMerchant(strapi, payload);
    const brand = await ensureBrand(strapi, payload.brand);
    const category = await ensureCategory(strapi, payload.category);
    const product = await upsertProduct(strapi, payload, brand, category);
    const offer = await upsertOffer(strapi, payload, product, merchant);
    const snapshot = await createSnapshot(strapi, payload, product, merchant, offer);

    return {
      product: formatProductResult({ ...product, offers: [offer] }),
      merchant: { id: merchant.id, documentId: merchant.documentId, name: merchant.name, slug: merchant.slug },
      offer: { id: offer.id, documentId: offer.documentId, price: offer.price, currency: offer.currency, status: offer.status },
      snapshotCreated: !!snapshot,
    };
  },

  async searchPostPrices(params = {}) {
    const post = await findPost(strapi, params);
    if (!post) {
      throw new Error('NXT post not found. Save the post first, then run price search.');
    }

    const keyword = clean(params.keyword) || clean(post.priceComparisonKeyword) || clean(post.title);
    if (!keyword || keyword.length < 2) {
      throw new Error('Add a price comparison keyword before running price search.');
    }

    const merchantLimit = clampInteger(params.perMerchantLimit || post.priceComparisonMerchantLimit, 1, 10, 2);
    const now = new Date().toISOString();

    try {
      const searchResponse = await searchSourcingApp({
        keyword,
        merchantSlugs: Array.isArray(params.merchantSlugs) ? params.merchantSlugs : [],
        perMerchantLimit: merchantLimit,
      });
      const results = cheapestByMerchant(searchResponse.results || []);
      const snapshot = {
        keyword,
        generatedAt: now,
        source: 'nxt-sourcing',
        mode: searchResponse.mode || 'unknown',
        message: searchResponse.message,
        rawCount: Array.isArray(searchResponse.results) ? searchResponse.results.length : 0,
        perMerchantLimit: merchantLimit,
        results,
      };

      await updatePostPriceFields(strapi, post, {
        priceComparisonEnabled: true,
        priceComparisonKeyword: keyword,
        priceComparisonMerchantLimit: merchantLimit,
        priceComparisonStatus: 'success',
        priceComparisonLastRunAt: now,
        priceComparisonError: null,
        priceComparisonResults: snapshot,
      });

      return {
        ok: true,
        post: { id: post.id, documentId: post.documentId, title: post.title, slug: post.slug },
        keyword,
        count: results.length,
        results,
      };
    } catch (error) {
      const message = error?.message || 'Post price search failed';
      await updatePostPriceFields(strapi, post, {
        priceComparisonKeyword: keyword,
        priceComparisonMerchantLimit: merchantLimit,
        priceComparisonStatus: 'failed',
        priceComparisonLastRunAt: now,
        priceComparisonError: message,
      });
      throw error;
    }
  },
});

function clean(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function shortDescription(value) {
  const text = clean(value)?.replace(/\s+/g, ' ');
  if (!text) return undefined;
  if (text.length <= 360) return text;

  const boundary = text.lastIndexOf(' ', 356);
  return `${text.slice(0, boundary > 240 ? boundary : 357).trim()}...`;
}

function number(value) {
  const text = clean(value);
  if (!text) return undefined;
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function slugify(value) {
  return slugifyLib(String(value || ''), { lower: true, strict: true }).slice(0, 180);
}

function normalizeUrl(value) {
  const text = clean(value);
  if (!text) throw new Error('Missing URL');
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function availability(value) {
  const text = clean(value)?.toLowerCase();
  if (!text) return 'unknown';
  if (['in_stock', 'instock', 'in stock', 'available', 'true', 'yes', '1'].includes(text)) return 'in_stock';
  if (['out_of_stock', 'out of stock', 'unavailable', 'sold out', 'false', 'no', '0'].includes(text)) return 'out_of_stock';
  if (['preorder', 'pre-order', 'pre order'].includes(text)) return 'preorder';
  return 'unknown';
}

function condition(value) {
  const text = clean(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (['new', 'used', 'refurbished', 'open_box'].includes(text)) return text;
  return 'unknown';
}

function discountPercent(price, originalPrice) {
  if (!price || !originalPrice || originalPrice <= price) return undefined;
  return Math.round((1 - price / originalPrice) * 10000) / 100;
}

function first(...values) {
  return values.find((value) => clean(value));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, ' ')
    .trim();
}

function extractMeta(html) {
  const out = {};
  const re = /<meta\s+([^>]+)>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1];
    const key = attr(attrs, 'property') || attr(attrs, 'name') || attr(attrs, 'itemprop');
    const content = attr(attrs, 'content');
    if (key && content) out[key.toLowerCase()] = decodeHtml(content);
  }
  return out;
}

function attr(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*(['"])(.*?)\\1`, 'i');
  return attrs.match(re)?.[2];
}

function extractTitle(html) {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
}

function jsonLdValue(html, pathParts) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const raw = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const parsed = JSON.parse(raw);
      const value = findJsonValue(parsed, pathParts);
      if (value !== undefined) return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

function findJsonValue(value, pathParts) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonValue(item, pathParts);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  let current = value;
  for (const part of pathParts) {
    current = Array.isArray(current?.[part]) ? current[part][0] : current?.[part];
    if (current === undefined || current === null) return undefined;
  }
  return current;
}

function absolutize(value, baseUrl) {
  const text = clean(value);
  if (!text) return undefined;
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return text;
  }
}

function hostToName(hostname) {
  return hostname
    .split('.')[0]
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatProductResult(product) {
  const offers = product.offers || [];
  const bestOffer = offers
    .filter((offer) => offer.price !== undefined && offer.price !== null)
    .sort((a, b) => Number(a.price) - Number(b.price))[0] || offers[0];

  return {
    id: product.id,
    documentId: product.documentId,
    name: product.name,
    slug: product.slug,
    brand: product.brandRef?.name || product.brand,
    category: product.categories?.[0]?.name || product.category,
    imageUrl: product.primaryImage?.url,
    asin: product.asin,
    gtin: product.gtin,
    mpn: product.mpn,
    sku: product.sku,
    bestOffer: bestOffer ? {
      id: bestOffer.id,
      documentId: bestOffer.documentId,
      merchantName: bestOffer.merchant?.name,
      merchantSlug: bestOffer.merchant?.slug,
      price: bestOffer.price,
      currency: bestOffer.currency,
      productUrl: bestOffer.productUrl,
      affiliateUrl: bestOffer.affiliateUrl,
      availability: bestOffer.availability,
    } : null,
  };
}

async function findPost(strapi, params) {
  const documentId = clean(params.documentId);
  if (documentId) {
    const post = await strapi.documents(NXT_POST_UID).findOne({ documentId });
    if (post) return post;
  }

  const slug = clean(params.slug);
  if (slug) {
    const rows = await strapi.documents(NXT_POST_UID).findMany({
      filters: { slug: { $eq: slug } },
      pagination: { pageSize: 1 },
    });
    if (rows[0]) return rows[0];
  }

  return null;
}

async function updatePostPriceFields(strapi, post, data) {
  const update = {
    documentId: post.documentId,
    data,
  };
  if (post.publishedAt) update.status = 'published';
  return strapi.documents(NXT_POST_UID).update(update);
}

async function searchSourcingApp({ keyword, merchantSlugs, perMerchantLimit }) {
  const body = JSON.stringify({
    keyword,
    merchants: merchantSlugs,
    filters: {
      productType: 'all',
      excludeAccessories: true,
      sortBy: 'price_asc',
      perMerchantLimit,
    },
  });
  let lastError;

  for (const baseUrl of sourcingBaseUrls()) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = {};
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${text}`);
      }

      return payload || {};
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Sourcing search failed: ${lastError?.message || 'could not reach sourcing app'}`);
}

function sourcingBaseUrls() {
  const urls = [
    clean(process.env.NXT_SOURCING_URL || process.env.COMMERCE_SOURCING_URL),
    'http://127.0.0.1:3005',
    'http://172.18.0.1:3006',
    'http://172.18.0.1:3005',
  ].filter(Boolean);
  return [...new Set(urls)];
}

function cheapestByMerchant(results) {
  const grouped = new Map();

  for (const item of Array.isArray(results) ? results : []) {
    const merchantSlug = clean(item.merchantSlug);
    const merchantName = clean(item.merchantName);
    if (!merchantSlug || !merchantName) continue;

    const row = {
      merchantSlug,
      merchantName,
      productName: clean(item.productName) || 'Product',
      brand: clean(item.brand),
      category: clean(item.category),
      imageUrl: clean(item.imageUrl),
      productUrl: clean(item.productUrl),
      affiliateUrl: clean(item.affiliateUrl),
      price: number(item.price),
      originalPrice: number(item.originalPrice),
      currency: clean(item.currency) || 'USD',
      availability: clean(item.availability) || 'unknown',
      condition: clean(item.condition) || 'unknown',
      source: clean(item.source) || 'nxt-sourcing',
      sku: clean(item.sku),
      merchantSku: clean(item.merchantSku),
      rating: number(item.rating),
      ratingCount: number(item.ratingCount),
    };

    if (!row.productUrl && !row.affiliateUrl) continue;
    const current = grouped.get(merchantSlug);
    if (!current || priceRank(row) < priceRank(current)) {
      grouped.set(merchantSlug, row);
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const delta = priceRank(a) - priceRank(b);
    if (delta) return delta;
    return a.merchantName.localeCompare(b.merchantName);
  });
}

function priceRank(item) {
  return item.price === undefined ? Number.MAX_SAFE_INTEGER : item.price;
}

async function findOne(strapi, uid, filters, populate) {
  const rows = await strapi.documents(uid).findMany({
    status: 'published',
    filters,
    populate,
    pagination: { pageSize: 1 },
  });
  return rows[0] || null;
}

async function findMerchantByHost(strapi, hostname) {
  const merchants = await strapi.documents(MERCHANT_UID).findMany({
    status: 'published',
    pagination: { pageSize: 200 },
  });

  return merchants.find((merchant) => {
    const website = clean(merchant.websiteUrl);
    if (!website) return false;
    try {
      const merchantHost = new URL(website).hostname.replace(/^www\./, '');
      return hostname === merchantHost || hostname.endsWith(`.${merchantHost}`);
    } catch {
      return false;
    }
  }) || null;
}

async function ensureMerchant(strapi, payload) {
  const slug = slugify(clean(payload.merchantSlug) || clean(payload.merchantName) || clean(payload.merchantWebsite));
  if (!slug) throw new Error('Missing merchant slug or name');

  const existing = await findOne(strapi, MERCHANT_UID, { slug: { $eq: slug } });
  if (existing) return existing;

  return strapi.documents(MERCHANT_UID).create({
    status: 'published',
    data: {
      name: clean(payload.merchantName) || slug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
      slug,
      websiteUrl: clean(payload.merchantWebsite),
      country: clean(payload.country),
      affiliateNetwork: clean(payload.affiliateNetwork),
      status: 'active',
      trackingParams: { source: 'commerce-product-finder' },
    },
  });
}

async function ensureBrand(strapi, name) {
  const brandName = clean(name);
  if (!brandName) return null;
  const slug = slugify(brandName);
  const existing = await findOne(strapi, BRAND_UID, { slug: { $eq: slug } });
  if (existing) return existing;

  return strapi.documents(BRAND_UID).create({
    status: 'published',
    data: { name: brandName, slug, status: 'active' },
  });
}

async function ensureCategory(strapi, name) {
  const categoryName = clean(name);
  if (!categoryName) return null;
  const slug = slugify(categoryName);
  const existing = await findOne(strapi, CATEGORY_UID, { slug: { $eq: slug } });
  if (existing) return existing;

  return strapi.documents(CATEGORY_UID).create({
    status: 'published',
    data: { name: categoryName, slug, status: 'active' },
  });
}

async function uploadImage(strapi, imageUrl, filename) {
  const url = clean(imageUrl);
  if (!url) return null;

  const prepared = await prepareImageForUpload(strapi, url);
  const response = await fetch(prepared.url);
  if (!response.ok) return null;

  const mime = prepared.contentType || response.headers.get('content-type') || 'image/jpeg';
  if (!mime.startsWith('image/')) return null;

  const extension = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const uploadName = prepared.backgroundRemoved ? `${filename}-no-bg` : filename;
  const tmp = path.join(os.tmpdir(), `${uploadName}-${Date.now()}.${extension}`);
  fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));

  try {
    const stats = fs.statSync(tmp);
    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: {
        fileInfo: {
          name: uploadName,
          alternativeText: uploadName.replace(/-/g, ' '),
        },
      },
      files: {
        filepath: tmp,
        originalFilename: `${uploadName}.${extension}`,
        mimetype: mime,
        size: stats.size,
      },
    });
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    return file ? { ...file, productImage: prepared } : file;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
  }
}

async function prepareImageForUpload(strapi, imageUrl) {
  const fallback = {
    url: imageUrl,
    sourceUrl: imageUrl,
    backgroundRemoved: false,
  };

  if (process.env.FAL_BACKGROUND_REMOVAL_ENABLED !== 'true' || !process.env.FAL_KEY) return fallback;

  try {
    const model = process.env.FAL_BACKGROUND_REMOVAL_MODEL || 'fal-ai/imageutils/rembg';
    const response = await fetch(`https://fal.run/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: imageUrl,
        sync_mode: false,
        crop_to_bbox: false,
      }),
    });

    if (!response.ok) throw new Error(`fal.ai HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.image?.url) throw new Error('fal.ai returned no image URL');

    return {
      url: data.image.url,
      sourceUrl: imageUrl,
      contentType: data.image.content_type,
      backgroundRemoved: true,
      backgroundProvider: model,
    };
  } catch (error) {
    strapi.log.warn(`Product image background removal failed: ${error.message || error}`);
    return fallback;
  }
}

async function upsertProduct(strapi, payload, brand, category) {
  const productDocumentId = clean(payload.productDocumentId);
  if (productDocumentId) {
    const existing = await strapi.documents(PRODUCT_UID).findOne({
      documentId: productDocumentId,
      populate: { primaryImage: true, brandRef: true, categories: true, offers: { populate: { merchant: true } } },
    });
    if (existing) return existing;
  }

  const existing = await findExistingProduct(strapi, payload);
  if (existing) return existing;

  const name = clean(payload.productName);
  const slug = slugify(clean(payload.productSlug) || name);
  const image = await uploadImage(strapi, payload.imageUrl, `commerce-product-${slug}`);

  return strapi.documents(PRODUCT_UID).create({
    status: 'published',
    data: {
      name,
      slug,
      brand: clean(payload.brand),
      brandRef: brand?.documentId,
      shortDescription: shortDescription(clean(payload.shortDescription) || clean(payload.description)),
      description: clean(payload.description),
      primaryImage: image?.id,
      category: clean(payload.category),
      categories: category ? [category.documentId] : [],
      tags: ['commerce-product-finder'],
      specs: {
        source: 'commerce-product-finder',
        sourceUrl: clean(payload.productUrl),
        imageUrl: image?.url,
        sourceImageUrl: image?.productImage?.sourceUrl || clean(payload.imageUrl),
        imageBackgroundRemoved: image?.productImage?.backgroundRemoved || undefined,
        imageBackgroundProvider: image?.productImage?.backgroundProvider,
        imageBackgroundStorage: image?.productImage?.backgroundRemoved ? 'strapi-media' : undefined,
        imageBackgroundRemovedAt: image?.productImage?.backgroundRemoved ? new Date().toISOString() : undefined,
        importedAt: new Date().toISOString(),
      },
      asin: clean(payload.asin),
      gtin: clean(payload.gtin),
      mpn: clean(payload.mpn),
      sku: clean(payload.sku),
      rating: number(payload.rating),
      ratingCount: number(payload.ratingCount),
      status: 'active',
    },
  });
}

async function findExistingProduct(strapi, payload) {
  const candidates = [
    ['gtin', clean(payload.gtin), '$eqi'],
    ['asin', clean(payload.asin), '$eqi'],
    ['mpn', clean(payload.mpn), '$eqi'],
    ['sku', clean(payload.sku), '$eqi'],
    ['slug', slugify(clean(payload.productSlug) || clean(payload.productName)), '$eq'],
  ];

  for (const [field, value, op] of candidates) {
    if (!value) continue;
    const item = await findOne(strapi, PRODUCT_UID, { [field]: { [op]: value } }, {
      primaryImage: true,
      brandRef: true,
      categories: true,
      offers: { populate: { merchant: true } },
    });
    if (item) return item;
  }
  return null;
}

async function findOffer(strapi, product, merchant, payload) {
  const productUrl = clean(payload.productUrl);
  const affiliateUrl = clean(payload.affiliateUrl);
  const merchantSku = clean(payload.merchantSku) || clean(payload.asin) || clean(payload.sku);
  const filters = productUrl || affiliateUrl
    ? { $or: [{ productUrl: { $eq: productUrl } }, { affiliateUrl: { $eq: affiliateUrl || productUrl } }] }
    : { merchantSku: { $eq: merchantSku } };

  const candidates = await strapi.documents(OFFER_UID).findMany({
    filters,
    populate: { product: true, merchant: true },
    pagination: { pageSize: 50 },
  });

  return candidates.find((offer) =>
    offer.product?.documentId === product.documentId &&
    offer.merchant?.documentId === merchant.documentId
  ) || null;
}

async function upsertOffer(strapi, payload, product, merchant) {
  const price = number(payload.price);
  const originalPrice = number(payload.originalPrice);
  const productUrl = clean(payload.productUrl) || clean(payload.affiliateUrl);
  const existing = await findOffer(strapi, product, merchant, payload);
  const data = {
    product: product.documentId,
    merchant: merchant.documentId,
    title: clean(payload.offerTitle) || clean(payload.productName),
    price,
    originalPrice,
    currency: clean(payload.currency) || 'USD',
    discountPercent: number(payload.discountPercent) ?? discountPercent(price, originalPrice),
    productUrl,
    affiliateUrl: clean(payload.affiliateUrl),
    couponCode: clean(payload.couponCode),
    availability: availability(payload.availability),
    shippingCost: number(payload.shippingCost),
    condition: condition(payload.condition),
    merchantSku: clean(payload.merchantSku) || clean(payload.asin) || clean(payload.sku),
    source: clean(payload.source) || 'commerce-product-finder',
    lastCheckedAt: new Date().toISOString(),
    status: clean(payload.offerStatus) || 'active',
  };

  if (existing) {
    return strapi.documents(OFFER_UID).update({ documentId: existing.documentId, data });
  }

  return strapi.documents(OFFER_UID).create({ data });
}

async function createSnapshot(strapi, payload, product, merchant, offer) {
  const price = number(payload.price);
  if (price === undefined) return null;

  return strapi.documents(SNAPSHOT_UID).create({
    data: {
      product: product.documentId,
      merchant: merchant.documentId,
      offer: offer.documentId,
      price,
      originalPrice: number(payload.originalPrice),
      currency: clean(payload.currency) || 'USD',
      availability: availability(payload.availability),
      checkedAt: new Date().toISOString(),
      source: clean(payload.source) || 'commerce-product-finder',
      rawPayload: payload,
    },
  });
}
