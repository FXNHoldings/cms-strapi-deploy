import { STRAPI_API_TOKEN, STRAPI_URL, strapiHeaders } from './config';
import { maybeCreateGeniuslinkUrl } from './geniuslink';
import { getCommerceMerchants } from './merchants';
import { enrichProductSearchResultForImport, repriceByProductSearch, searchAllProviders } from './providers';
import { prepareProductImage, uploadRemoteImageToStrapi, type ProductImagePreparation } from './product-image-background';
import { slugify } from './slug';
import { type StorefrontKey } from './storefronts';
import type { AddToStrapiResult, ProductSearchResult } from './types';

type StrapiItem = {
  id: number;
  documentId: string;
  [key: string]: unknown;
};

type OfferLookupItem = StrapiItem & {
  product?: { documentId?: string };
  merchant?: { documentId?: string };
};

type AddToStrapiOptions = {
  dryRun?: boolean;
  importSpecs?: boolean;
  importDescription?: boolean;
  overwriteProductDetails?: boolean;
  // When set (e.g. from the bulk-add category picker), all added products are
  // assigned to this category instead of the per-product detected one.
  categoryName?: string;
  // When set, the offer is attached to THIS existing product (by documentId)
  // instead of matching/creating one. Used by "combine selected into one
  // product" so listings from different marketplaces share a single product.
  targetProductDocumentId?: string;
  // Destination storefront — the product is tagged with this key so the right
  // site shows it (nxt.bargains filters tags for `nxt-bargains`, etc.).
  storefront?: StorefrontKey;
};

export async function addProductToStrapi(
  item: ProductSearchResult,
  options: AddToStrapiOptions = {},
): Promise<AddToStrapiResult> {
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      message: 'Dry run passed. No Strapi records were written.',
    };
  }

  if (!STRAPI_API_TOKEN) {
    return {
      ok: false,
      dryRun: false,
      message: 'STRAPI_API_TOKEN is not configured for this sourcing app.',
    };
  }

  const enrichedItem = await enrichProductSearchResultForImport(item, {
    importSpecs: options.importSpecs,
    importDescription: options.importDescription,
  });
  const linkedItem = await maybeCreateGeniuslinkUrl(enrichedItem);
  const merchant = await ensureMerchant(linkedItem);
  const brand = await ensureBrand(linkedItem.brand);
  // A chosen target category (from bulk add) overrides the detected one.
  const categoryName = options.categoryName?.trim() || linkedItem.category;
  const category = await ensureCategory(categoryName);
  // "Combine into one product": attach this offer to the chosen existing
  // product instead of matching/creating a new one. Its details/image are
  // merged only where missing, so the first product's default image is kept.
  let product: StrapiItem;
  if (options.targetProductDocumentId) {
    const target = await findById('commerce-products', options.targetProductDocumentId);
    if (!target) {
      return { ok: false, dryRun: false, message: 'Target product not found for combine.' };
    }
    product = await ensureProductDetails(target, linkedItem, options);
  } else {
    product = await ensureProduct({ ...linkedItem, category: categoryName }, brand, category, options);
  }
  const offer = await upsertOffer(linkedItem, product, merchant);
  const snapshot = await createPriceSnapshot(linkedItem, product, merchant, offer);

  return {
    ok: true,
    dryRun: false,
    message: 'Product and offer saved to Strapi Commerce.',
    product,
    offer,
    snapshot,
  };
}

/**
 * Daily price refresh. For each product, search Real-Time Product Search by the
 * saved product name, match returned offers back to existing merchants, update
 * those offers, and write price snapshots for the chart/alerts.
 */
export async function refreshAllProductPrices(opts: { limit?: number } = {}): Promise<{
  processed: number;
  snapshots: number;
  offersUpdated: number;
  skipped: number;
}> {
  if (!STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is not configured.');
  const configuredLimit = Number(process.env.PRICE_REFRESH_LIMIT || '25');
  const limit = opts.limit ?? (Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 25);
  const configuredPoolSize = Number(process.env.PRICE_REFRESH_POOL_SIZE || '200');
  const pageSize = Math.max(
    limit,
    Number.isFinite(configuredPoolSize) && configuredPoolSize > 0 ? Math.floor(configuredPoolSize) : 200,
  );
  let page = 1;
  let processed = 0;
  let snapshots = 0;
  let offersUpdated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  while (processed < limit) {
    const params = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': String(pageSize),
      'fields[0]': 'name',
      'fields[1]': 'slug',
      'fields[2]': 'brand',
      'fields[3]': 'sku',
      'filters[productStatus][$eq]': 'active',
      'populate[offers][populate][0]': 'merchant',
      'sort[0]': 'updatedAt:desc',
    });
    const res = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
      headers: strapiHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Strapi product list failed: HTTP ${res.status}`);
    const json = await res.json();
    const rows: StrapiItem[] = (json?.data ?? []).sort(compareStaleProductsFirst);
    if (!rows.length) break;

    for (const p of rows) {
      if (processed >= limit) break;
      processed += 1;
      const productName = typeof p.name === 'string' ? p.name : '';
      const offers = Array.isArray(p.offers) ? (p.offers as StrapiItem[]) : [];
      if (!productName || offers.length === 0) { skipped += 1; continue; }

      try {
        const refreshed = await repriceByProductSearch(productName);
        const matches = matchRefreshResultsToOffers(p, offers, refreshed);
        if (!matches.length) { skipped += 1; continue; }

        for (const { offer, merchant, result } of matches) {
          if (result.price === undefined) continue;
          const updatedOffer = await update('commerce-offers', offer.documentId, {
            title: result.productName,
            price: result.price,
            originalPrice: result.originalPrice,
            currency: result.currency || 'USD',
            discountPercent: discountPercent(result.price, result.originalPrice),
            productUrl: result.productUrl,
            affiliateUrl: result.affiliateUrl,
            availability: result.availability,
            condition: result.condition,
            merchantSku: boundedString(result.merchantSku || result.sku || offer.merchantSku, 120),
            source: result.source || 'product-search-api',
            lastCheckedAt: now,
            status: 'active',
            syncError: undefined,
          });
          offersUpdated += 1;

          await create('commerce-price-snapshots', {
            product: p.documentId,
            merchant: merchant.documentId,
            offer: updatedOffer.documentId || offer.documentId,
            price: result.price,
            originalPrice: result.originalPrice,
            currency: result.currency || 'USD',
            availability: result.availability || 'unknown',
            checkedAt: now,
            source: 'product-search-refresh',
            rawPayload: result,
          });
          snapshots += 1;
        }
      } catch (error) {
        console.error('[price-refresh] skipped product:', productName, error);
        skipped += 1;
      }
    }

    const pageCount = json?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page += 1;
  }

  return { processed, snapshots, offersUpdated, skipped };
}

export async function refreshMerchantProductPrices(opts: {
  merchantSlugs: string[];
  limit?: number;
}): Promise<{
  processed: number;
  snapshots: number;
  offersUpdated: number;
  skipped: number;
  merchants: string[];
}> {
  if (!STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is not configured.');

  const merchantSlugs = Array.from(new Set(opts.merchantSlugs.map((slug) => slug.trim()).filter(Boolean)));
  if (!merchantSlugs.length) throw new Error('At least one merchant slug is required.');

  const configuredLimit = Number(process.env.MERCHANT_PRICE_REFRESH_LIMIT || process.env.PRICE_REFRESH_LIMIT || '100');
  const limit = opts.limit ?? (Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 100);
  const configuredPoolSize = Number(process.env.MERCHANT_PRICE_REFRESH_POOL_SIZE || '300');
  const pageSize = Math.max(
    limit,
    Number.isFinite(configuredPoolSize) && configuredPoolSize > 0 ? Math.floor(configuredPoolSize) : 300,
  );
  const merchants = (await getCommerceMerchants()).filter((merchant) => merchantSlugs.includes(merchant.slug));
  if (!merchants.length) throw new Error(`No configured merchants found for: ${merchantSlugs.join(', ')}`);

  let page = 1;
  let processed = 0;
  let snapshots = 0;
  let offersUpdated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  while (processed < limit) {
    const params = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': String(pageSize),
      'fields[0]': 'name',
      'fields[1]': 'slug',
      'fields[2]': 'brand',
      'fields[3]': 'sku',
      'filters[productStatus][$eq]': 'active',
      'populate[offers][populate][0]': 'merchant',
      'sort[0]': 'updatedAt:desc',
    });
    const res = await fetch(`${STRAPI_URL}/api/commerce-products?${params.toString()}`, {
      headers: strapiHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Strapi product list failed: HTTP ${res.status}`);
    const json = await res.json();
    const rows: StrapiItem[] = (json?.data ?? []).sort(compareStaleProductsFirst);
    if (!rows.length) break;

    for (const p of rows) {
      if (processed >= limit) break;
      const productName = typeof p.name === 'string' ? p.name : '';
      const offers = Array.isArray(p.offers) ? (p.offers as StrapiItem[]) : [];
      const targetOffers = offers.filter((offer) => {
        const merchant = offer.merchant as StrapiItem | undefined;
        return merchant?.slug && merchantSlugs.includes(String(merchant.slug));
      });
      if (!productName || targetOffers.length === 0) continue;

      processed += 1;

      try {
        const refreshed = await searchAllProviders({
          keyword: productName,
          merchants,
          filters: {
            productType: 'all',
            productCondition: 'all',
            excludeAccessories: true,
            perMerchantLimit: Number(process.env.MERCHANT_PRICE_REFRESH_PER_MERCHANT_LIMIT || '10'),
            sortBy: 'relevance',
          },
        });
        const matches = matchRefreshResultsToOffers(p, targetOffers, refreshed);
        if (!matches.length) { skipped += 1; continue; }

        for (const { offer, merchant, result } of matches) {
          if (result.price === undefined) continue;
          const updatedOffer = await update('commerce-offers', offer.documentId, {
            title: result.productName,
            price: result.price,
            originalPrice: result.originalPrice,
            currency: result.currency || 'USD',
            discountPercent: discountPercent(result.price, result.originalPrice),
            productUrl: result.productUrl,
            affiliateUrl: result.affiliateUrl,
            availability: result.availability,
            condition: result.condition,
            merchantSku: boundedString(result.merchantSku || result.sku || offer.merchantSku, 120),
            source: result.source || `${result.merchantSlug}-price-refresh`,
            lastCheckedAt: now,
            status: 'active',
            syncError: undefined,
          });
          offersUpdated += 1;

          await create('commerce-price-snapshots', {
            product: p.documentId,
            merchant: merchant.documentId,
            offer: updatedOffer.documentId || offer.documentId,
            price: result.price,
            originalPrice: result.originalPrice,
            currency: result.currency || 'USD',
            availability: result.availability || 'unknown',
            checkedAt: now,
            source: `${result.merchantSlug}-price-refresh`,
            rawPayload: result,
          });
          snapshots += 1;
        }
      } catch (error) {
        console.error('[merchant-price-refresh] skipped product:', productName, error);
        skipped += 1;
      }
    }

    const pageCount = json?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page += 1;
  }

  return { processed, snapshots, offersUpdated, skipped, merchants: merchants.map((merchant) => merchant.slug) };
}

function matchRefreshResultsToOffers(
  product: StrapiItem,
  offers: StrapiItem[],
  results: ProductSearchResult[],
) {
  const matches: Array<{ offer: StrapiItem; merchant: StrapiItem; result: ProductSearchResult }> = [];
  const usedResults = new Set<ProductSearchResult>();

  for (const offer of offers) {
    const merchant = offer.merchant as StrapiItem | undefined;
    const merchantSlug = String(merchant?.slug || '');
    if (!offer.documentId || !merchant?.documentId || !merchantSlug) continue;

    const candidates = results
      .filter((result) => result.price !== undefined && !usedResults.has(result))
      .filter((result) => result.merchantSlug === merchantSlug || sameOfferHost(result.productUrl, String(offer.productUrl || offer.affiliateUrl || '')))
      .map((result) => ({ result, score: refreshMatchScore(product, offer, result) }))
      .filter((entry) => entry.score >= 6)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0]?.result;
    if (!best) continue;
    usedResults.add(best);
    matches.push({ offer, merchant, result: best });
  }

  return matches;
}

function refreshMatchScore(product: StrapiItem, offer: StrapiItem, result: ProductSearchResult) {
  const productText = normalizedProductText(String(product.name || ''));
  const offerText = normalizedProductText(String(offer.title || ''));
  const resultText = normalizedProductText(result.productName);
  const sourceUrl = String(offer.productUrl || offer.affiliateUrl || '');
  let score = 0;

  for (const token of significantTokens(productText)) {
    if (resultText.includes(token)) score += 1;
  }
  for (const token of significantTokens(offerText).slice(0, 8)) {
    if (resultText.includes(token)) score += 0.5;
  }
  const storage = productText.match(/\b(128gb|256gb|512gb|1tb|2tb)\b/)?.[1];
  if (storage) score += resultText.includes(storage) ? 3 : -6;
  if (sameOfferHost(result.productUrl, sourceUrl)) score += 3;
  if (String(offer.condition || '') === result.condition) score += 1;

  return score;
}

function normalizedProductText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function significantTokens(value: string) {
  const stop = new Set(['apple', 'samsung', 'google', 'phone', 'smartphone', 'cell', 'new', 'unlocked', 'refurbished', 'restored', '5g', 'gb', 'tb']);
  return Array.from(new Set(value.split(' ').filter((token) => token.length >= 2 && !stop.has(token))));
}

function sameOfferHost(a?: string, b?: string) {
  const hostA = hostname(a);
  const hostB = hostname(b);
  return Boolean(hostA && hostB && (hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`)));
}

function hostname(value?: string) {
  try {
    return new URL(value || '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

async function ensureMerchant(item: ProductSearchResult): Promise<StrapiItem> {
  const websiteUrl = originFromUrl(item.productUrl);
  const existing = await findMerchantWithLogo(item.merchantSlug);
  if (existing) {
    // Backfill a logo for merchants that were created before logos were saved.
    if (!existing.logo) {
      const logoId = await fetchMerchantLogoMediaId(websiteUrl, item.merchantSlug);
      if (logoId) return update('commerce-merchants', existing.documentId, { logo: logoId });
    }
    return existing;
  }

  const logoId = await fetchMerchantLogoMediaId(websiteUrl, item.merchantSlug);
  return create('commerce-merchants', {
    name: item.merchantName,
    slug: item.merchantSlug,
    websiteUrl,
    logo: logoId ?? undefined,
    merchantStatus: 'active',
    trackingParams: { source: 'nxt-sourcing' },
  });
}

// Look up a merchant by slug WITH its logo populated, so we know whether to
// download one.
async function findMerchantWithLogo(slug: string): Promise<StrapiItem | null> {
  const params = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'populate[logo]': 'true',
    'pagination[pageSize]': '1',
  });
  const res = await fetch(`${STRAPI_URL}/api/commerce-merchants?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data?.[0] || null;
}

// Auto-download a merchant logo by domain and upload it to Strapi media.
// Tries Clearbit's logo API first (clean brand logos), then falls back to the
// site's favicon. Returns the uploaded media id, or null if nothing worked.
async function fetchMerchantLogoMediaId(websiteUrl: string | undefined, slug: string): Promise<number | null> {
  let domain = '';
  try {
    domain = new URL(websiteUrl || '').hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!domain) return null;

  const candidates = [
    `https://logo.clearbit.com/${domain}`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
  ];
  for (const url of candidates) {
    try {
      const upload = await uploadRemoteImageToStrapi(url, `merchant-logo-${slug}`);
      if (upload?.id) return upload.id;
    } catch {
      // try the next source
    }
  }
  return null;
}

async function ensureBrand(name?: string): Promise<StrapiItem | null> {
  if (!name) return null;
  const slug = slugify(name);
  const existing = await findOne('commerce-brands', { slug });
  if (existing) return existing;

  return create('commerce-brands', {
    name,
    slug,
    brandStatus: 'active',
  });
}

async function ensureCategory(name?: string): Promise<StrapiItem | null> {
  if (!name) return null;
  const slug = slugify(name);
  const existing = await findOne('commerce-categories', { slug });
  if (existing) return existing;

  return create('commerce-categories', {
    name,
    slug,
    categoryStatus: 'active',
  });
}

async function ensureProduct(
  item: ProductSearchResult,
  brand: StrapiItem | null,
  category: StrapiItem | null,
  options: AddToStrapiOptions,
): Promise<StrapiItem> {
  const productSlug = slugify(item.productName);
  // Try each strong identifier in turn, then ALWAYS fall back to the slug.
  // Checking the slug last ensures we update an existing product that shares
  // the slug (e.g. added earlier without/with a different asin) instead of
  // attempting a create that fails Strapi's unique-slug constraint.
  const match =
    (item.gtin ? await findOne('commerce-products', { gtin: item.gtin }) : null) ||
    (item.asin ? await findOne('commerce-products', { asin: item.asin }) : null) ||
    (item.mpn ? await findOne('commerce-products', { mpn: item.mpn }) : null) ||
    (item.sku ? await findOne('commerce-products', { sku: item.sku }) : null) ||
    (await findOne('commerce-products', { slug: productSlug }));

  if (match) return ensureProductDetails(match, item, options);

  const preparedImage = await prepareProductImage(item.imageUrl, `commerce-product-${productSlug}`);

  return create('commerce-products', {
    name: item.productName,
    slug: productSlug,
    brand: item.brand,
    brandRef: brand?.documentId,
    shortDescription: options.importDescription ? shortDescriptionValue(item.shortDescription || item.description) : undefined,
    description: options.importDescription ? item.description || item.shortDescription : undefined,
    category: item.category,
    categories: category ? [category.documentId] : [],
    primaryImage: preparedImage.mediaId,
    tags: ['nxt-sourcing', options.storefront].filter(Boolean),
    specs: productSpecsPayload(item, options, {
      source: item.source,
      confidence: item.confidence,
      sourceUrl: item.productUrl,
      ...productImageSpecs(preparedImage, item.source),
      importedAt: new Date().toISOString(),
    }),
    asin: item.asin,
    gtin: item.gtin,
    mpn: item.mpn,
    sku: item.sku,
    rating: item.rating,
    ratingCount: item.ratingCount,
    productStatus: 'active',
  });
}

async function ensureProductDetails(
  product: StrapiItem,
  item: ProductSearchResult,
  options: AddToStrapiOptions,
): Promise<StrapiItem> {
  const data: Record<string, unknown> = {};
  const specs = isRecord(product.specs) ? product.specs : {};
  let nextSpecs = { ...specs };

  // Import an image only if this product doesn't already have one set, so the
  // first listing's image stays the default when combining marketplaces.
  const needsImage = item.imageUrl && isHttpUrl(item.imageUrl) && !specs.primaryImageImported;
  if (needsImage) {
    const preparedImage = await prepareProductImage(item.imageUrl, `commerce-product-${slugify(item.productName)}`);
    if (preparedImage.mediaId) data.primaryImage = preparedImage.mediaId;
    nextSpecs = {
      ...nextSpecs,
      ...productImageSpecs(preparedImage, item.source),
    };
  }

  if (options.importSpecs) {
    nextSpecs = mergeImportedSpecs(nextSpecs, item, Boolean(options.overwriteProductDetails));
  }

  if (JSON.stringify(nextSpecs) !== JSON.stringify(specs)) data.specs = nextSpecs;

  const overwrite = Boolean(options.overwriteProductDetails);
  if (item.asin && (overwrite || !product.asin)) data.asin = item.asin;
  if (item.gtin && (overwrite || !product.gtin)) data.gtin = item.gtin;
  if (item.sku && (overwrite || !product.sku)) data.sku = item.sku;

  if (options.importDescription) {
    const summary = shortDescriptionValue(item.shortDescription || item.description);
    if ((overwrite || !product.shortDescription) && summary) {
      data.shortDescription = summary;
    }
    if ((overwrite || !product.description) && (item.description || item.shortDescription)) {
      data.description = item.description || item.shortDescription;
    }
  }

  // Add the destination storefront tag if missing (a product can live on several
  // storefronts). Only touch tags when the existing array is available, so we
  // never clobber tags that weren't fetched.
  if (options.storefront && Array.isArray(product.tags)) {
    const current = (product.tags as unknown[]).filter((t): t is string => typeof t === 'string');
    const merged = Array.from(new Set([...current, 'nxt-sourcing', options.storefront]));
    if (merged.length !== current.length) data.tags = merged;
  }

  return Object.keys(data).length ? update('commerce-products', product.documentId, data) : product;
}

function productSpecsPayload(
  item: ProductSearchResult,
  options: AddToStrapiOptions,
  base: Record<string, unknown>,
) {
  return options.importSpecs ? mergeImportedSpecs(base, item, true) : base;
}

function productImageSpecs(image: ProductImagePreparation, source?: string): Record<string, unknown> {
  const now = new Date().toISOString();
  const specs: Record<string, unknown> = {};

  if (image.imageUrl) specs.imageUrl = image.imageUrl;
  if (image.sourceImageUrl) specs.sourceImageUrl = image.sourceImageUrl;
  if (image.backgroundRemoved) {
    specs.imageBackgroundRemoved = true;
    specs.imageBackgroundProvider = image.backgroundProvider;
    specs.imageBackgroundStorage = image.backgroundStorage;
    specs.imageBackgroundRemovedAt = now;
  }
  if (image.error) specs.imageBackgroundError = image.error;
  // Marks that a Strapi media primaryImage was actually set, so later updates
  // (e.g. combining more marketplaces) keep the existing default image.
  if (image.mediaId) specs.primaryImageImported = true;
  if (image.imageUrl || image.sourceImageUrl) {
    specs.imageSource = source || 'nxt-sourcing';
    specs.imageImportedAt = now;
  }

  return specs;
}

function mergeImportedSpecs(
  specs: Record<string, unknown>,
  item: ProductSearchResult,
  overwrite: boolean,
) {
  const incoming = importedSpecsFromItem(item);
  if (!incoming) return specs;

  const existingTechnicalSpecs = isRecord(specs.technicalSpecs) ? specs.technicalSpecs : {};
  const technicalSpecs = overwrite
    ? { ...existingTechnicalSpecs, ...incoming }
    : { ...incoming, ...existingTechnicalSpecs };

  return {
    ...specs,
    technicalSpecs,
    specSourceMerchant: item.merchantName,
    specSourceMerchantSlug: item.merchantSlug,
    specSourceUrl: item.productUrl,
    specImportedAt: new Date().toISOString(),
  };
}

function importedSpecsFromItem(item: ProductSearchResult) {
  const specs: Record<string, unknown> = {};

  if (isRecord(item.specifications)) {
    Object.entries(item.specifications).forEach(([key, value]) => {
      const cleanedKey = cleanSpecKey(key);
      const cleanedValue = cleanSpecValue(value);
      if (cleanedKey && cleanedValue !== undefined) specs[cleanedKey] = cleanedValue;
    });
  }

  if (Array.isArray(item.featureBullets) && item.featureBullets.length) {
    specs.Features = item.featureBullets.map((feature) => String(feature).trim()).filter(Boolean).slice(0, 20);
  }

  return Object.keys(specs).length ? specs : undefined;
}

function cleanSpecKey(value: string) {
  const key = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return key ? key.slice(0, 80) : undefined;
}

function cleanSpecValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === 'string') {
    const cleaned = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.map((entry) => String(entry).trim()).filter(Boolean);
    return items.length ? items.slice(0, 50) : undefined;
  }
  return undefined;
}

function shortDescriptionValue(value?: string) {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= 360) return cleaned;

  const boundary = cleaned.lastIndexOf(' ', 356);
  return `${cleaned.slice(0, boundary > 240 ? boundary : 357).trim()}...`;
}

async function upsertOffer(
  item: ProductSearchResult,
  product: StrapiItem,
  merchant: StrapiItem,
): Promise<StrapiItem> {
  const merchantSku = boundedString(item.merchantSku || item.sku || item.asin, 120);
  const existing = await findOffer(
    product.documentId,
    merchant.documentId,
    item.productUrl,
    item.affiliateUrl,
    merchantSku,
  );
  const data = {
    product: product.documentId,
    merchant: merchant.documentId,
    title: item.productName,
    price: item.price,
    originalPrice: item.originalPrice,
    currency: item.currency || 'USD',
    discountPercent: discountPercent(item.price, item.originalPrice),
    productUrl: item.productUrl,
    affiliateUrl: item.affiliateUrl,
    availability: item.availability || 'unknown',
    condition: item.condition || 'unknown',
    merchantSku,
    source: item.source || 'nxt-sourcing',
    lastCheckedAt: new Date().toISOString(),
    status: 'active',
    syncError: undefined,
  };

  if (existing) return update('commerce-offers', existing.documentId, data);
  return create('commerce-offers', data);
}

function compareStaleProductsFirst(a: StrapiItem, b: StrapiItem) {
  return oldestOfferCheckedAt(a) - oldestOfferCheckedAt(b);
}

function oldestOfferCheckedAt(product: StrapiItem) {
  const offers = Array.isArray(product.offers) ? (product.offers as StrapiItem[]) : [];
  if (!offers.length) return Number.POSITIVE_INFINITY;
  let oldest = Number.POSITIVE_INFINITY;
  for (const offer of offers) {
    const value = typeof offer.lastCheckedAt === 'string' ? Date.parse(offer.lastCheckedAt) : Number.NaN;
    oldest = Math.min(oldest, Number.isFinite(value) ? value : 0);
  }
  return oldest;
}

function boundedString(value: unknown, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

async function createPriceSnapshot(
  item: ProductSearchResult,
  product: StrapiItem,
  merchant: StrapiItem,
  offer: StrapiItem,
): Promise<StrapiItem | null> {
  if (item.price === undefined) return null;

  return create('commerce-price-snapshots', {
    product: product.documentId,
    merchant: merchant.documentId,
    offer: offer.documentId,
    price: item.price,
    originalPrice: item.originalPrice,
    currency: item.currency || 'USD',
    availability: item.availability || 'unknown',
    checkedAt: new Date().toISOString(),
    source: item.source || 'nxt-sourcing',
    rawPayload: item,
  });
}

async function findOne(collection: string, filters: Record<string, string>) {
  const params = new URLSearchParams({ 'pagination[pageSize]': '1' });
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(`filters[${key}][$eq]`, value);
  });

  const response = await fetch(`${STRAPI_URL}/api/${collection}?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi lookup failed for ${collection}: HTTP ${response.status}`);
  const json = await response.json();
  return json?.data?.[0] || null;
}

async function findById(collection: string, documentId: string): Promise<StrapiItem | null> {
  const response = await fetch(`${STRAPI_URL}/api/${collection}/${documentId}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const json = await response.json();
  return json?.data || null;
}

async function findOffer(
  productDocumentId: string,
  merchantDocumentId: string,
  productUrl: string,
  affiliateUrl?: string,
  merchantSku?: string,
) {
  const byMerchantSku = merchantSku
    ? await findOfferByFilter(productDocumentId, merchantDocumentId, {
        'filters[merchantSku][$eq]': merchantSku,
      })
    : null;
  if (byMerchantSku) return byMerchantSku;

  return findOfferByFilter(productDocumentId, merchantDocumentId, {
    'filters[$or][0][productUrl][$eq]': productUrl,
    'filters[$or][1][affiliateUrl][$eq]': affiliateUrl || productUrl,
  });
}

async function findOfferByFilter(
  productDocumentId: string,
  merchantDocumentId: string,
  filters: Record<string, string>,
) {
  const params = new URLSearchParams({
    'pagination[pageSize]': '25',
    'populate[0]': 'product',
    'populate[1]': 'merchant',
  });
  Object.entries(filters).forEach(([key, value]) => params.set(key, value));

  const response = await fetch(`${STRAPI_URL}/api/commerce-offers?${params.toString()}`, {
    headers: strapiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Strapi offer lookup failed: HTTP ${response.status}`);
  const json = await response.json();
  const rows: OfferLookupItem[] = Array.isArray(json?.data) ? json.data : [];
  return rows.find((offer) =>
    offer?.product?.documentId === productDocumentId &&
    offer?.merchant?.documentId === merchantDocumentId
  ) || null;
}

async function create(collection: string, data: Record<string, unknown>) {
  const response = await fetch(`${STRAPI_URL}/api/${collection}`, {
    method: 'POST',
    headers: strapiHeaders(),
    body: JSON.stringify({ data: prune(data) }),
  });
  if (!response.ok) throw new Error(`Strapi create failed for ${collection}: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data;
}

async function update(collection: string, documentId: string, data: Record<string, unknown>) {
  const response = await fetch(`${STRAPI_URL}/api/${collection}/${documentId}`, {
    method: 'PUT',
    headers: strapiHeaders(),
    body: JSON.stringify({ data: prune(data) }),
  });
  if (!response.ok) throw new Error(`Strapi update failed for ${collection}: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  return json.data;
}

function prune(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && value !== ''),
  );
}

function originFromUrl(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function discountPercent(price?: number | null, originalPrice?: number | null) {
  if (!price || !originalPrice || originalPrice <= price) return undefined;
  return Math.round((1 - price / originalPrice) * 10000) / 100;
}
