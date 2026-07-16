import type { Merchant, ProductSearchFilters, ProductSearchResult } from './types';
import { slugify } from './slug';

type SearchInput = {
  keyword: string;
  merchants: Merchant[];
  filters?: ProductSearchFilters;
};

type ImportEnrichmentOptions = {
  importSpecs?: boolean;
  importDescription?: boolean;
};

type ImpactSearchOptions = {
  campaignId?: string;
  catalogId?: string;
  endpoint?: string;
  pageSize?: number;
  query?: string;
  timeoutMs?: number;
};

type EbayItemSummary = {
  itemId?: string;
  title?: string;
  image?: { imageUrl?: string };
  price?: { value?: string; currency?: string };
  marketingPrice?: {
    originalPrice?: { value?: string; currency?: string };
  };
  itemWebUrl?: string;
  itemAffiliateWebUrl?: string;
  condition?: string;
  categories?: Array<{ categoryName?: string }>;
  epid?: string;
};

type EbaySearchResponse = {
  itemSummaries?: EbayItemSummary[];
};

type EbayBrowseItemDetail = Record<string, unknown> & {
  description?: string;
  shortDescription?: string;
  localizedAspects?: Array<{ name?: string; value?: string }>;
  product?: Record<string, unknown>;
  productInformation?: unknown;
};

type EbayFindingItem = {
  itemId?: string[];
  title?: string[];
  galleryURL?: string[];
  viewItemURL?: string[];
  primaryCategory?: Array<{ categoryName?: string[] }>;
  sellingStatus?: Array<{
    currentPrice?: Array<{ __value__?: string; '@currencyId'?: string }>;
  }>;
  condition?: Array<{ conditionDisplayName?: string[] }>;
};

type EbayFindingResponse = {
  findItemsByKeywordsResponse?: Array<{
    ack?: string[];
    searchResult?: Array<{
      item?: EbayFindingItem[];
    }>;
    errorMessage?: Array<{
      error?: Array<{ message?: string[] }>;
    }>;
  }>;
};

type AmazonSearchItem = ProductSearchApiRecord;
type AmazonSearchResponse = {
  data?: {
    products?: AmazonSearchItem[];
  };
  products?: AmazonSearchItem[];
};

type ProductSearchApiRecord = Record<string, unknown>;
type ProductSearchApiEntry = {
  product: ProductSearchApiRecord;
  offer?: ProductSearchApiRecord;
};

type EbayTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

let ebayApplicationTokenCache:
  | {
      accessToken: string;
      expiresAt: number;
    }
  | undefined;

const merchantHints: Record<string, { category: string; domain: string; currency: string }> = {
  'product-search': { category: 'Marketplace', domain: 'google.com/shopping', currency: 'USD' },
  impact: { category: 'Marketplace', domain: 'impact.com', currency: 'USD' },
  amazon: { category: 'Marketplace', domain: 'amazon.com', currency: 'USD' },
  ebay: { category: 'Marketplace', domain: 'ebay.com', currency: 'USD' },
  walmart: { category: 'Department Store', domain: 'walmart.com', currency: 'USD' },
  target: { category: 'Department Store', domain: 'target.com', currency: 'USD' },
  'best-buy': { category: 'Electronics', domain: 'bestbuy.com', currency: 'USD' },
  newegg: { category: 'Electronics', domain: 'newegg.com', currency: 'USD' },
  sephora: { category: 'Beauty', domain: 'sephora.com', currency: 'USD' },
  ulta: { category: 'Beauty', domain: 'ulta.com', currency: 'USD' },
  currys: { category: 'Electronics', domain: 'currys.co.uk', currency: 'GBP' },
  argos: { category: 'Department Store', domain: 'argos.co.uk', currency: 'GBP' },
  aliexpress: { category: 'Marketplace', domain: 'aliexpress.com', currency: 'USD' },
};

const productSearchMerchantSlugs = new Set(['target', 'newegg', 'best-buy']);

export async function searchAllProviders(input: SearchInput): Promise<ProductSearchResult[]> {
  const keyword = input.keyword.trim();
  if (!keyword) return [];

  const providerResults = await Promise.all(
    input.merchants.map((merchant) => searchMerchant(keyword, merchant, input.filters)),
  );

  const sorted = applySearchFilters(providerResults.flat(), keyword, input.filters).sort((a, b) => {
    if (input.filters?.sortBy === 'price_asc') return priceForSort(a) - priceForSort(b);
    if (input.filters?.sortBy === 'price_desc') return priceForSort(b) - priceForSort(a);

    const scoreDelta = relevanceScore(b, keyword, input.filters) - relevanceScore(a, keyword, input.filters);
    if (scoreDelta) return scoreDelta;
    return priceForSort(a) - priceForSort(b);
  });

  const limited = limitPerMerchant(sorted, input.filters?.perMerchantLimit ?? 2);
  return input.filters?.sortBy === 'price_asc' || input.filters?.sortBy === 'price_desc'
    ? limited
    : interleaveMerchantResults(limited);
}

export async function repriceByAsin(
  _asin: string,
): Promise<{ price?: number; originalPrice?: number; currency?: string; availability?: string } | null> {
  return null;
}

export async function repriceByProductSearch(keyword: string): Promise<ProductSearchResult[]> {
  const cleanKeyword = keyword.trim();
  if (!cleanKeyword || !hasProductSearchApiConfig()) return [];

  const limit = Number(process.env.PRICE_REFRESH_PRODUCT_SEARCH_LIMIT || '20');
  return searchProductSearchApi(cleanKeyword, {
    productType: 'all',
    productCondition: 'all',
    excludeAccessories: true,
    perMerchantLimit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 20,
    sortBy: 'relevance',
  });
}

export async function enrichProductSearchResultForImport(
  item: ProductSearchResult,
  options: ImportEnrichmentOptions = {},
): Promise<ProductSearchResult> {
  if (item.merchantSlug === 'amazon') {
    return enrichAmazonResultForImport(item, options);
  }

  if (item.merchantSlug === 'ebay' && (options.importDescription || options.importSpecs)) {
    return enrichEbayResultForImport(item, options);
  }

  return item;
}

async function enrichAmazonResultForImport(
  item: ProductSearchResult,
  options: ImportEnrichmentOptions,
): Promise<ProductSearchResult> {
  const asin = amazonAsinForImport(item);
  const key = getAmazonDetailApiKey();
  if (!asin || !key) return item;

  try {
    const detail = await fetchAmazonProductDetail(asin);
    const productInformation = amazonProductInformationFromDetail(detail);
    const productInformationRecord = isRecord(productInformation) ? productInformation : {};
    const identifiers = amazonIdentifiersFromDetail(detail, productInformationRecord, item, asin);
    const specs = {
      ...(item.specifications || {}),
      ...amazonIdentifierSpecs(identifiers),
      ...(productSpecsFromRecords(detail, productInformationRecord) || {}),
      ...specsFromNameValueList(productInformation),
    };
    const description =
      amazonDescriptionFromDetail(detail) ||
      descriptionField(detail, [
        'Product Description',
        'productDescription',
        'product_description',
        'description',
        'Description',
        'product_details',
        'ProductDetails',
        'overview',
        'about_product',
      ]);
    const shortDescription =
      amazonShortDescriptionFromDetail(detail) ||
      descriptionField(detail, [
        'short_description',
        'ShortDescription',
        'product_title',
        'title',
        'product_description',
        'description',
        'overview',
      ]);
    const featureBullets = [
      ...(item.featureBullets || []),
      ...stringArrayField(detail, ['about_product', 'features', 'feature_bullets', 'highlights']),
    ].filter(Boolean);

    return {
      ...item,
      brand: item.brand || amazonBrandFromByline(stringField(detail, ['product_byline', 'byline'])) || stringField(detail, ['brand', 'product_brand']),
      category: item.category || stringField(detail, ['product_category', 'category', 'department']),
      asin: identifiers.asin || item.asin,
      gtin: identifiers.ean || identifiers.gtin || item.gtin,
      sku: identifiers.sku || item.sku || (identifiers.asin ? `amazon-${identifiers.asin}`.slice(0, 100) : undefined),
      merchantSku: identifiers.merchantSku || item.merchantSku || identifiers.asin || item.asin,
      imageUrl:
        item.imageUrl ||
        urlField(detail, ['product_photo', 'product_image', 'image', 'thumbnail', 'main_image', 'mainImage']) ||
        stringArrayField(detail, ['product_photos', 'images', 'photos'])[0],
      price: item.price ?? amazonAsinPriceFromDetail(detail) ?? numberField(detail, ['rawPrice']),
      originalPrice: item.originalPrice ?? amazonAsinListPriceFromDetail(detail),
      availability: amazonAvailabilityFromDetail(detail, item.availability),
      rating: item.rating ?? numberField(detail, ['rating']) ?? numberField(isRecord(detail.rating) ? detail.rating : {}, ['rate', 'rating']),
      ratingCount: item.ratingCount ?? numberField(isRecord(detail.rating) ? detail.rating : {}, ['rate_count', 'rating_count', 'count']),
      ...(options.importDescription && description ? { description } : {}),
      ...(options.importDescription && shortDescription ? { shortDescription } : {}),
      ...(options.importSpecs && Object.keys(specs).length ? { specifications: specs } : {}),
      ...(options.importSpecs && featureBullets.length ? { featureBullets: Array.from(new Set(featureBullets)).slice(0, 20) } : {}),
    };
  } catch (error) {
    console.error('[providers] Amazon import enrichment failed:', error);
    return item;
  }
}

async function fetchAmazonProductDetail(asin: string): Promise<ImpactCatalogItem> {
  const key = getAmazonDetailApiKey();
  const provider = amazonDetailProvider();
  const host = process.env.RAPIDAPI_AMAZON_HOST || defaultAmazonHost(provider);
  const path = normalizeApiPath(process.env.RAPIDAPI_AMAZON_DETAILS_PATH || defaultAmazonDetailsPath(provider));
  const params = provider === 'amazon-asin' || provider === 'amazon-product-info2'
    ? new URLSearchParams({ asin })
    : new URLSearchParams({
        asin,
        country: process.env.RAPIDAPI_AMAZON_COUNTRY || 'US',
      });

  const response = await fetch(`https://${host}${path}?${params.toString()}`, {
    headers: {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': host,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(providerTimeoutMs('RAPIDAPI_AMAZON_DETAILS_TIMEOUT_MS', 15_000)),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const detail = amazonDetailFromPayload(payload);
  if (!detail) throw new Error('Amazon product details payload did not include a product record.');
  return detail;
}

function amazonDetailFromPayload(payload: unknown): ImpactCatalogItem | null {
  if (!isRecord(payload)) return null;
  for (const key of ['body', 'data', 'product', 'product_details', 'result', 'item']) {
    const value = payload[key];
    if (isRecord(value)) return value;
  }
  return looksLikeProductSearchRecord(payload) || payload.asin || payload.product_title || payload.title || payload.name ? payload : null;
}

function amazonDetailProvider() {
  const configured = String(process.env.RAPIDAPI_AMAZON_PROVIDER || '').trim().toLowerCase();
  if (configured === 'amazon-asin') return 'amazon-asin';
  if (configured === 'amazon-product-info2') return 'amazon-product-info2';

  const host = String(process.env.RAPIDAPI_AMAZON_HOST || '').toLowerCase();
  if (host.includes('amazon-asin')) return 'amazon-asin';
  if (host.includes('amazon-product-info2')) return 'amazon-product-info2';

  return 'real-time-amazon-data';
}

function defaultAmazonHost(provider: string) {
  if (provider === 'amazon-asin') return 'amazon-asin.p.rapidapi.com';
  if (provider === 'amazon-product-info2') return 'amazon-product-info2.p.rapidapi.com';
  return 'real-time-amazon-data.p.rapidapi.com';
}

function defaultAmazonDetailsPath(provider: string) {
  if (provider === 'amazon-asin') return '/asin.php';
  if (provider === 'amazon-product-info2') return '/Amazon/details_asin';
  return '/product-details';
}

function amazonAsinForImport(item: ProductSearchResult) {
  for (const value of [
    item.asin,
    item.merchantSku,
    item.sku?.replace(/^amazon-/i, ''),
    asinFromUrl(item.productUrl),
    asinFromUrl(item.affiliateUrl),
  ]) {
    const asin = validAsin(value);
    if (asin) return asin;
  }
  return undefined;
}

function validAsin(value?: string) {
  const candidate = value?.trim().toUpperCase();
  return candidate && /^[A-Z0-9]{10}$/.test(candidate) ? candidate : undefined;
}

function amazonProductInformationFromDetail(detail: ImpactCatalogItem): unknown {
  for (const key of [
    'product_information',
    'ProductInformation',
    'productInformation',
    'product_info',
    'ProductInfo',
    'product_details',
    'ProductDetails',
    'technical_details',
    'TechnicalDetails',
    'details',
    'Details',
    'attributes',
    'Attributes',
    'specifications',
    'Specifications',
  ]) {
    const value = detail[key];
    if (value) return value;
  }
  return undefined;
}

async function enrichEbayResultForImport(
  item: ProductSearchResult,
  options: ImportEnrichmentOptions,
): Promise<ProductSearchResult> {
  try {
    if (process.env.EBAY_OAUTH_TOKEN || getEbayClientSecret()) {
      return await enrichEbayBrowseResultForImport(item, options);
    }

    if (getEbayClientId()) {
      return await enrichEbayShoppingResultForImport(item, options);
    }
  } catch (error) {
    console.error('[providers] eBay import enrichment failed:', error);
  }

  return item;
}

async function enrichEbayBrowseResultForImport(
  item: ProductSearchResult,
  options: ImportEnrichmentOptions,
): Promise<ProductSearchResult> {
  const itemId = item.merchantSku || item.sku;
  if (!itemId) return item;

  const accessToken = await getEbayAccessToken();
  const params = new URLSearchParams({ fieldgroups: 'PRODUCT' });
  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
      },
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const detail = (await response.json()) as EbayBrowseItemDetail;
  const productInformation = ebayProductInformationFromDetail(detail);
  const productInformationRecord = isRecord(productInformation) ? productInformation : {};
  const specs = {
    ...(item.specifications || {}),
    ...(productSpecsFromRecords(detail, detail.product || {}, productInformationRecord) || {}),
    ...specsFromNameValueList(detail.localizedAspects),
    ...specsFromNameValueList(productInformation),
  };
  const description = cleanDescriptionText(
    detail.description ||
      descriptionField(detail, ['Description', 'Product Description', 'productDescription', 'product_description']) ||
      detail.shortDescription ||
      '',
  );
  const shortDescription = cleanDescriptionText(
    detail.shortDescription ||
      descriptionField(detail, ['ShortDescription', 'Subtitle', 'title', 'description']) ||
      description ||
      '',
  );

  return {
    ...item,
    ...(options.importDescription && description ? { description } : {}),
    ...(options.importDescription && shortDescription ? { shortDescription } : {}),
    ...(options.importSpecs && Object.keys(specs).length ? { specifications: specs } : {}),
  };
}

async function enrichEbayShoppingResultForImport(
  item: ProductSearchResult,
  options: ImportEnrichmentOptions,
): Promise<ProductSearchResult> {
  const itemId = String(item.merchantSku || item.sku || '').replace(/^v1\|([^|]+)\|.*$/, '$1');
  const appId = getEbayClientId();
  if (!itemId || !appId) return item;

  const params = new URLSearchParams({
    callname: 'GetSingleItem',
    responseencoding: 'JSON',
    appid: appId,
    siteid: process.env.EBAY_SHOPPING_SITE_ID || '0',
    version: process.env.EBAY_SHOPPING_VERSION || '967',
    ItemID: itemId,
    IncludeSelector: 'Details,Description,ItemSpecifics',
  });

  const response = await fetch(`https://open.api.ebay.com/shopping?${params.toString()}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const detail = isRecord(payload) && isRecord(payload.Item) ? payload.Item : {};
  const itemSpecifics = isRecord(detail.ItemSpecifics) ? detail.ItemSpecifics.NameValueList : undefined;
  const productInformation = ebayProductInformationFromDetail(detail);
  const productInformationRecord = isRecord(productInformation) ? productInformation : {};
  const specs = {
    ...(item.specifications || {}),
    ...(productSpecsFromRecords(detail, productInformationRecord) || {}),
    ...specsFromNameValueList(itemSpecifics),
    ...specsFromNameValueList(productInformation),
  };
  const description = cleanDescriptionText(
    stringField(detail, ['Description', 'ProductDescription', 'Product Description', 'Subtitle']) || '',
  );
  const shortDescription = cleanDescriptionText(stringField(detail, ['Subtitle', 'Title', 'Description']) || '');

  return {
    ...item,
    ...(options.importDescription && description ? { description } : {}),
    ...(options.importDescription && shortDescription ? { shortDescription } : {}),
    ...(options.importSpecs && Object.keys(specs).length ? { specifications: specs } : {}),
  };
}

async function searchMerchant(
  keyword: string,
  merchant: Merchant,
  filters?: ProductSearchFilters,
): Promise<ProductSearchResult[]> {
  if (merchant.slug === 'product-search' && hasProductSearchApiConfig()) {
    try {
      return await searchProductSearchApi(keyword, filters);
    } catch (error) {
      console.error('[providers] Real-Time Product Search failed:', error);
      return maybeDemo(keyword, merchant);
    }
  }

  if (merchant.slug === 'impact' && hasImpactConfig()) {
    try {
      return await searchImpact(keyword, filters);
    } catch (error) {
      console.error('[providers] Impact search failed:', error);
      return maybeDemo(keyword, merchant);
    }
  }

  if (merchant.slug === 'walmart' && hasImpactConfig()) {
    try {
      return await searchWalmartImpact(keyword, merchant, filters);
    } catch (error) {
      console.error('[providers] Walmart Impact search failed:', error);
      return maybeDemo(keyword, merchant);
    }
  }

  if (merchant.slug === 'ebay' && hasEbayConfig()) {
    try {
      return await searchEbay(keyword, merchant, filters);
    } catch (error) {
      console.error('[providers] eBay search failed:', error);
      return maybeDemo(keyword, merchant);
    }
  }

  if (merchant.slug === 'amazon' && hasAmazonSearchConfig()) {
    try {
      return await searchAmazon(keyword, merchant, filters);
    } catch (error) {
      console.error('[providers] Amazon Product Info2 search failed:', error);
      return maybeDemo(keyword, merchant);
    }
  }

  if (productSearchMerchantSlugs.has(merchant.slug) && hasProductSearchApiConfig()) {
    try {
      return await searchProductSearchApiForMerchant(keyword, merchant, filters);
    } catch (error) {
      console.error(`[providers] Product Search failed for ${merchant.name}:`, error);
      return maybeDemo(keyword, merchant);
    }
  }

  return maybeDemo(keyword, merchant);
}

async function searchAmazon(
  keyword: string,
  merchant: Merchant,
  filters?: ProductSearchFilters,
): Promise<ProductSearchResult[]> {
  const key = getDedicatedAmazonSearchApiKey();
  const provider = amazonDetailProvider();
  const host = process.env.RAPIDAPI_AMAZON_SEARCH_HOST || process.env.RAPIDAPI_AMAZON_HOST || defaultAmazonHost(provider);
  const path = normalizeApiPath(process.env.RAPIDAPI_AMAZON_SEARCH_PATH || (provider === 'amazon-product-info2' ? '/Amazon/serp' : '/search'));
  const limit = productSearchApiLimit(filters);
  const params = new URLSearchParams({
    query: keyword,
    page: '1',
  });

  if (provider !== 'amazon-product-info2') {
    params.set('country', process.env.RAPIDAPI_AMAZON_COUNTRY || 'US');
    params.set('sort_by', process.env.RAPIDAPI_AMAZON_SORT_BY || 'RELEVANCE');
    params.set('product_condition', amazonProductCondition(filters));
  }

  const response = await fetch(`https://${host}${path}?${params.toString()}`, {
    headers: {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': host,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as AmazonSearchResponse;
  const products = amazonSearchProductsFromPayload(payload);
  return products
    .slice(0, limit)
    .map((item) => mapAmazonSearchItem(item, merchant))
    .filter((item): item is ProductSearchResult => Boolean(item));
}

function amazonSearchProductsFromPayload(payload: unknown): AmazonSearchItem[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const body = isRecord(payload.body) ? payload.body : undefined;
  const data = isRecord(payload.data) ? payload.data : undefined;
  const containers = [payload, body, data].filter(isRecord);
  const products: AmazonSearchItem[] = [];

  for (const container of containers) {
    for (const key of ['products', 'results', 'items', 'search_results']) {
      const value = container[key];
      if (Array.isArray(value)) products.push(...value.filter(isRecord));
    }
  }

  return products;
}

function hasAmazonSearchConfig() {
  return Boolean(hasDedicatedAmazonSearchConfig() || hasProductSearchApiConfig());
}

function hasDedicatedAmazonSearchConfig() {
  return Boolean(getDedicatedAmazonSearchApiKey());
}

function getDedicatedAmazonSearchApiKey() {
  return process.env.RAPIDAPI_AMAZON_KEY || process.env.RAPIDAPI_PRODUCT_SEARCH_KEY || process.env.RAPIDAPI_KEY || '';
}

function getAmazonDetailApiKey() {
  return process.env.RAPIDAPI_AMAZON_KEY || process.env.RAPIDAPI_PRODUCT_SEARCH_KEY || process.env.RAPIDAPI_KEY || '';
}

function mapAmazonSearchItem(item: AmazonSearchItem, merchant: Merchant): ProductSearchResult | null {
  const productName = stringField(item, ['product_title', 'title', 'name']);
  const asin = stringField(item, ['asin', 'product_asin']);
  const ean = stringField(item, ['ean', 'EAN', 'gtin', 'GTIN', 'upc', 'UPC']);
  const sku = stringField(item, ['sku', 'SKU', 'product_sku', 'seller_sku', 'merchant_sku']);
  const productUrl = amazonAffiliateUrl(asin, urlField(item, ['product_url', 'url', 'canonicalUrl']));

  if (!productName || !productUrl) return null;

  return {
    source: amazonDetailProvider() === 'amazon-product-info2' ? 'amazon-product-info2' : 'amazon-rapidapi',
    merchantSlug: merchant.slug,
    merchantName: merchant.name,
    productName,
    brand: amazonBrandFromByline(stringField(item, ['product_byline', 'byline'])) || inferBrand(productName),
    category: stringField(item, ['product_category', 'category']) || 'Marketplace',
    shortDescription: amazonShortDescriptionFromDetail(item),
    description: amazonDescriptionFromDetail(item),
    featureBullets: stringArrayField(item, ['about_product', 'features', 'feature_bullets']),
    specifications: productSpecsFromRecords(item),
    imageUrl:
      urlField(item, ['product_photo', 'product_image', 'image', 'thumbnail', 'main_image', 'mainImage']) ||
      stringArrayField(item, ['product_photos', 'images', 'photos'])[0],
    productUrl,
    affiliateUrl: productUrl,
    price: moneyField(item, ['product_price', 'price', 'current_price']) ?? numberField(item, ['rawPrice']),
    originalPrice: moneyField(item, ['product_original_price', 'original_price', 'list_price']),
    currency: currencyCodeFromSymbol(stringField(item, ['currency'])) || currencyFromMoneyText(stringField(item, ['product_price', 'price'])) || 'USD',
    availability: normalizeAmazonAvailability(stringField(item, ['product_availability', 'availability'])),
    condition: normalizeCondition(stringField(item, ['product_condition', 'condition'])),
    asin,
    gtin: ean,
    sku: sku || (asin ? `amazon-${asin}`.slice(0, 100) : undefined),
    merchantSku: asin,
    rating: numberField(item, ['product_star_rating', 'rating']) ?? ratingFromText(stringField(item, ['customerReview'])),
    ratingCount: numberField(item, ['product_num_ratings', 'rating_count', 'reviews_count']) ?? numberField(item, ['customerReviewCount']),
    confidence: 'api',
  };
}

function amazonAffiliateUrl(asin?: string, productUrl?: string) {
  const tag = process.env.NEXT_PUBLIC_AMAZON_AFFILIATE_TAG || process.env.AMAZON_AFFILIATE_TAG || '';
  const url = asin ? `https://www.amazon.com/dp/${asin}` : productUrl;
  if (!url || !tag) return url || '';
  return `${url}${url.includes('?') ? '&' : '?'}tag=${encodeURIComponent(tag)}`;
}

function amazonProductCondition(filters?: ProductSearchFilters) {
  if (filters?.productCondition === 'new') return 'NEW';
  if (filters?.productCondition === 'renewed') return 'RENEWED';
  return process.env.RAPIDAPI_AMAZON_CONDITION || 'ALL';
}

async function searchProductSearchApiForMerchant(
  keyword: string,
  merchant: Merchant,
  filters?: ProductSearchFilters,
): Promise<ProductSearchResult[]> {
  const results = await searchProductSearchApi(keyword, filters, { store: merchant.name });
  const merchantResults = results
    .filter((item) => merchant.slug === 'amazon' || matchesProductSearchMerchant(item, merchant))
    .map((item) => normalizeStoreSpecificResult(item, merchant, keyword, {
      discoveryOnly: merchant.slug === 'amazon' && !matchesProductSearchMerchant(item, merchant),
    }));

  if (merchantResults.length || !hasImpactConfig()) return merchantResults;

  const impactResults = await searchImpact(`${keyword} ${merchant.name}`, filters);
  return impactResults
    .filter((item) => matchesProductSearchMerchant(item, merchant))
    .map((item) => normalizeStoreSpecificResult(item, merchant, keyword));
}

function normalizeStoreSpecificResult(
  item: ProductSearchResult,
  merchant: Merchant,
  keyword: string,
  options: { discoveryOnly?: boolean } = {},
): ProductSearchResult {
  const storeUrl = options.discoveryOnly || isGoogleShoppingUrl(item.productUrl)
    ? merchantSearchUrl(item.productName || keyword, merchant)
    : item.productUrl;

  return {
    ...item,
    merchantSlug: merchant.slug,
    merchantName: merchant.name,
    productUrl: storeUrl,
    affiliateUrl: item.affiliateUrl && !isGoogleShoppingUrl(item.affiliateUrl) ? item.affiliateUrl : storeUrl,
    ...(options.discoveryOnly
      ? {
          source: 'amazon-product-search-discovery',
          availability: 'unknown' as const,
        }
      : {}),
  };
}

async function searchProductSearchApi(
  keyword: string,
  filters?: ProductSearchFilters,
  options: { store?: string } = {},
): Promise<ProductSearchResult[]> {
  const key = getProductSearchApiKey();
  const host = process.env.RAPIDAPI_PRODUCT_SEARCH_HOST || 'real-time-product-search.p.rapidapi.com';
  const path = normalizeApiPath(process.env.RAPIDAPI_PRODUCT_SEARCH_PATH || '/search-v2');
  const limit = productSearchApiLimit(filters);
  const params = new URLSearchParams({
    q: keyword,
    country: process.env.RAPIDAPI_PRODUCT_SEARCH_COUNTRY || 'us',
    language: process.env.RAPIDAPI_PRODUCT_SEARCH_LANGUAGE || 'en',
    page: '1',
    limit: String(limit),
    sort_by: productSearchApiSort(),
  });

  const productSearchCondition = rapidApiProductSearchCondition(filters);
  if (productSearchCondition) {
    params.set('product_condition', productSearchCondition);
  }

  if (options.store) {
    params.set('stores', options.store);
  }

  const response = await fetch(`https://${host}${path}?${params.toString()}`, {
    headers: {
      'x-rapidapi-key': key,
      'x-rapidapi-host': host,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  return productSearchEntriesFromPayload(payload)
    .slice(0, limit)
    .map((entry) => mapProductSearchApiEntry(entry))
    .filter((item): item is ProductSearchResult => Boolean(item));
}

function hasProductSearchApiConfig() {
  return Boolean(getProductSearchApiKey());
}

function getProductSearchApiKey() {
  return process.env.RAPIDAPI_PRODUCT_SEARCH_KEY || process.env.RAPIDAPI_KEY || '';
}

function productSearchApiLimit(filters?: ProductSearchFilters) {
  const configured = Number(process.env.RAPIDAPI_PRODUCT_SEARCH_LIMIT || (filters ? '50' : '25'));
  if (!Number.isFinite(configured) || configured <= 0) return 25;
  return Math.min(Math.floor(configured), 100);
}

function productSearchApiSort() {
  return process.env.RAPIDAPI_PRODUCT_SEARCH_SORT_BY || 'BEST_MATCH';
}

function rapidApiProductSearchCondition(filters?: ProductSearchFilters) {
  if (filters?.productCondition === 'new') return 'NEW';
  if (filters?.productCondition === 'renewed') return 'RENEWED';
  return process.env.RAPIDAPI_PRODUCT_SEARCH_CONDITION || '';
}

function normalizeApiPath(value: string) {
  const path = value.trim() || '/search-v2';
  return path.startsWith('/') ? path : `/${path}`;
}

function productSearchEntriesFromPayload(payload: unknown): ProductSearchApiEntry[] {
  return productSearchProductsFromPayload(payload).flatMap((product) => {
    const offers = productSearchOffersFromProduct(product);
    return offers.length ? offers.map((offer) => ({ product, offer })) : [{ product }];
  });
}

function productSearchProductsFromPayload(payload: unknown): ProductSearchApiRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (looksLikeProductSearchRecord(payload)) return [payload];

  const records: ProductSearchApiRecord[] = [];
  const containers = [payload, isRecord(payload.data) ? payload.data : undefined].filter(isRecord);
  const collectionKeys = [
    'products',
    'results',
    'items',
    'shopping_results',
    'product_results',
    'organic_results',
    'sponsored_products',
    'sponsored_results',
    'product_offers',
    'offers',
  ];

  if (Array.isArray(payload.data)) records.push(...payload.data.filter(isRecord));

  containers.forEach((container) => {
    collectionKeys.forEach((key) => {
      const value = container[key];
      if (Array.isArray(value)) records.push(...value.filter(isRecord));
    });
  });

  return dedupeRecords(records.filter(looksLikeProductSearchRecord));
}

function productSearchOffersFromProduct(product: ProductSearchApiRecord) {
  const offers: ProductSearchApiRecord[] = [];
  const offerKeys = ['offer', 'best_offer', 'top_offer'];
  const offerCollectionKeys = ['offers', 'product_offers', 'sellers', 'online_sellers', 'nearby_offers'];

  offerKeys.forEach((key) => {
    const value = product[key];
    if (isRecord(value)) offers.push(value);
  });

  offerCollectionKeys.forEach((key) => {
    const value = product[key];
    if (Array.isArray(value)) offers.push(...value.filter(isRecord));
  });

  return dedupeRecords(offers);
}

function mapProductSearchApiEntry(entry: ProductSearchApiEntry): ProductSearchResult | null {
  const product = entry.product;
  const offer = entry.offer;
  const offerRecord = offer || product;
  const productName =
    stringField(product, ['product_title', 'title', 'name', 'product_name']) ||
    stringField(offerRecord, ['product_title', 'title', 'name', 'product_name']);
  const productUrl =
    urlField(offerRecord, ['offer_page_url', 'product_offer_page_url', 'url', 'link', 'product_url', 'product_page_url']) ||
    urlField(product, ['offer_page_url', 'product_offer_page_url', 'product_page_url', 'url', 'link', 'product_url']);

  if (!productName || !productUrl) return null;

  const merchantName =
    stringField(offerRecord, ['store_name', 'merchant_name', 'merchant', 'seller', 'seller_name', 'shop_name', 'source']) ||
    stringField(product, ['store_name', 'merchant_name', 'merchant', 'seller', 'seller_name', 'shop_name', 'source']) ||
    merchantNameFromUrl(productUrl) ||
    'Product Search';
  const imageUrl =
    urlField(product, ['product_photo', 'product_image', 'image', 'thumbnail']) ||
    urlField(offerRecord, ['product_photo', 'product_image', 'image', 'thumbnail']) ||
    stringArrayField(product, ['product_photos', 'images', 'photos'])[0] ||
    stringArrayField(offerRecord, ['product_photos', 'images', 'photos'])[0];
  const price = moneyField(offerRecord, ['price', 'current_price', 'sale_price', 'offer_price', 'product_price']);
  const originalPrice =
    moneyField(offerRecord, ['original_price', 'list_price', 'was_price', 'retail_price']) ||
    moneyField(product, ['original_price', 'list_price', 'was_price', 'retail_price']);
  const productId =
    stringField(product, ['product_id', 'id', 'item_id']) ||
    stringField(offerRecord, ['product_id', 'offer_id', 'id', 'item_id']);
  const gtin = stringField(product, ['gtin', 'GTIN', 'upc', 'UPC', 'ean', 'EAN']);
  const mpn = stringField(product, ['mpn', 'MPN', 'manufacturer_part_number']);
  const asin =
    stringField(product, ['asin', 'ASIN', 'product_asin']) ||
    stringField(offerRecord, ['asin', 'ASIN', 'product_asin']) ||
    asinFromUrl(productUrl);
  const currency =
    stringField(offerRecord, ['currency', 'currency_code']) ||
    stringField(product, ['currency', 'currency_code']) ||
    currencyFromMoneyText(
      stringField(offerRecord, ['price', 'current_price', 'sale_price', 'offer_price', 'product_price']) ||
      stringField(product, ['price', 'current_price', 'sale_price', 'offer_price', 'product_price']),
    ) ||
    'USD';
  const merchantSlug = merchantSlugForProductSearch(merchantName, productUrl);

  return {
    source: 'product-search-api',
    merchantSlug,
    merchantName,
    productName,
    brand:
      stringField(product, ['brand', 'product_brand', 'manufacturer']) ||
      stringField(offerRecord, ['brand', 'product_brand', 'manufacturer']) ||
      inferBrand(productName),
    category: stringField(product, ['category', 'product_category', 'department', 'shopping_category']) || 'Marketplace',
    shortDescription: productSearchShortDescription(product, offerRecord, merchantSlug),
    description: productSearchDescription(product, offerRecord, merchantSlug),
    featureBullets: productSearchFeatureBullets(product, offerRecord, merchantSlug),
    specifications: productSearchSpecifications(product, offerRecord, merchantSlug),
    imageUrl,
    productUrl,
    affiliateUrl: productUrl,
    price,
    originalPrice,
    currency,
    availability: normalizeProductSearchAvailability(stringField(offerRecord, ['availability', 'stock_status', 'shipping'])),
    condition: normalizeCondition(stringField(offerRecord, ['product_condition', 'condition'])),
    asin,
    gtin,
    mpn,
    sku: productId ? `product-search-${slugify(productId)}`.slice(0, 100) : undefined,
    merchantSku:
      stringField(offerRecord, ['merchant_sku', 'seller_sku', 'sku', 'offer_id', 'docid']) ||
      productId ||
      undefined,
    rating:
      numberField(product, ['product_rating', 'rating', 'reviews_rating']) ||
      numberField(offerRecord, ['store_rating', 'rating']),
    ratingCount:
      numberField(product, ['product_num_reviews', 'product_num_ratings', 'review_count', 'reviews_count']) ||
      numberField(offerRecord, ['store_review_count', 'review_count', 'reviews_count']),
    confidence: 'api',
  };
}

function productSearchShortDescription(
  product: ProductSearchApiRecord,
  offerRecord: ProductSearchApiRecord,
  merchantSlug: string,
) {
  if (merchantSlug === 'newegg') {
    return descriptionField(product, [
      'short_description',
      'ShortDescription',
      'shortDescription',
      'summary',
      'Summary',
      'snippet',
      'description',
    ]) || descriptionField(offerRecord, ['short_description', 'ShortDescription', 'shortDescription', 'summary', 'snippet']);
  }

  return descriptionField(product, ['product_description', 'short_description', 'snippet', 'description']) ||
    descriptionField(offerRecord, ['product_description', 'short_description', 'snippet', 'description']);
}

function productSearchDescription(
  product: ProductSearchApiRecord,
  offerRecord: ProductSearchApiRecord,
  merchantSlug: string,
) {
  if (merchantSlug === 'target') {
    return descriptionField(product, ['Details', 'details', 'Product Details', 'ProductDetails', 'product_details']) ||
      descriptionField(offerRecord, ['Details', 'details', 'Product Details', 'ProductDetails', 'product_details']);
  }

  return descriptionField(product, ['description', 'product_description', 'product_details', 'overview']) ||
    descriptionField(offerRecord, ['description', 'product_description', 'product_details', 'overview']);
}

function productSearchFeatureBullets(
  product: ProductSearchApiRecord,
  offerRecord: ProductSearchApiRecord,
  merchantSlug: string,
) {
  const keys = merchantSlug === 'best-buy'
    ? ['Features', 'features', 'feature_bullets', 'highlights', 'Highlights', 'about_product']
    : ['features', 'feature_bullets', 'highlights', 'about_product'];
  return Array.from(new Set([
    ...stringArrayField(product, keys),
    ...stringArrayField(offerRecord, keys),
  ])).slice(0, 20);
}

function productSearchSpecifications(
  product: ProductSearchApiRecord,
  offerRecord: ProductSearchApiRecord,
  merchantSlug: string,
) {
  const specs = {
    ...(productSpecsFromRecords(product, offerRecord) || {}),
  };

  if (merchantSlug === 'target') {
    collectSpecsFromValue(product.Specifications ?? product.specifications, specs);
    collectSpecsFromValue(offerRecord.Specifications ?? offerRecord.specifications, specs);
    setSpec(specs, 'Details', descriptionField(product, ['Details', 'details']) || descriptionField(offerRecord, ['Details', 'details']));
  }

  if (merchantSlug === 'newegg') {
    collectSpecsFromValue(product.Specs ?? product.specs, specs);
    collectSpecsFromValue(offerRecord.Specs ?? offerRecord.specs, specs);
  }

  if (merchantSlug === 'best-buy') {
    collectSpecsFromValue(product.Specifications ?? product.specifications, specs);
    collectSpecsFromValue(offerRecord.Specifications ?? offerRecord.specifications, specs);
    setSpec(specs, 'Features', productSearchFeatureBullets(product, offerRecord, merchantSlug));
  }

  return Object.keys(specs).length ? specs : undefined;
}

async function searchEbay(
  keyword: string,
  merchant: Merchant,
  filters?: ProductSearchFilters,
): Promise<ProductSearchResult[]> {
  if (!getEbayClientSecret() && !process.env.EBAY_OAUTH_TOKEN && getEbayClientId()) {
    return searchEbayFinding(keyword, merchant, filters);
  }

  const accessToken = await getEbayAccessToken();
  const params = new URLSearchParams({
    q: keyword,
    limit: process.env.EBAY_LIMIT || (filters ? '50' : '25'),
  });

  const response = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as EbaySearchResponse;
  return (payload.itemSummaries || [])
    .filter((item) => item.title && item.itemWebUrl)
    .map((item) => {
      const price = toNumber(item.price?.value);
      const originalPrice = toNumber(item.marketingPrice?.originalPrice?.value);
      return {
        source: 'ebay-browse-api',
        merchantSlug: merchant.slug,
        merchantName: merchant.name,
        productName: item.title || 'eBay item',
        category: item.categories?.[0]?.categoryName || 'Marketplace',
        specifications: {
          ...(item.condition ? { Condition: item.condition } : {}),
          ...(item.epid ? { ePID: item.epid } : {}),
        },
        imageUrl: item.image?.imageUrl,
        productUrl: item.itemWebUrl || '',
        affiliateUrl: item.itemAffiliateWebUrl || item.itemWebUrl,
        price,
        originalPrice,
        currency: item.price?.currency || item.marketingPrice?.originalPrice?.currency || 'USD',
        availability: 'in_stock',
        condition: normalizeCondition(item.condition),
        sku: item.itemId,
        merchantSku: item.itemId,
        mpn: item.epid,
        confidence: 'api',
      };
    });
}

function hasEbayConfig() {
  return Boolean(process.env.EBAY_OAUTH_TOKEN || getEbayClientId());
}

async function searchEbayFinding(
  keyword: string,
  merchant: Merchant,
  filters?: ProductSearchFilters,
): Promise<ProductSearchResult[]> {
  const appId = getEbayClientId();
  if (!appId) throw new Error('Missing eBay App ID. Set EBAY_APP_ID or EBAY_CLIENT_ID.');

  const params = new URLSearchParams({
    'OPERATION-NAME': 'findItemsByKeywords',
    'SERVICE-VERSION': process.env.EBAY_FINDING_SERVICE_VERSION || '1.13.0',
    'SECURITY-APPNAME': appId,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'REST-PAYLOAD': '',
    keywords: keyword,
    'paginationInput.entriesPerPage': process.env.EBAY_LIMIT || (filters ? '50' : '25'),
    'paginationInput.pageNumber': '1',
    'GLOBAL-ID': process.env.EBAY_GLOBAL_ID || 'EBAY-US',
    'sortOrder': ebayFindingSortOrder(filters),
  });

  const response = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params.toString()}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as EbayFindingResponse;
  const root = payload.findItemsByKeywordsResponse?.[0];
  const ack = root?.ack?.[0];
  if (ack && !/^success|warning$/i.test(ack)) {
    const message = root?.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'eBay Finding API request failed';
    throw new Error(message);
  }

  return (root?.searchResult?.[0]?.item || [])
    .filter((item) => item.title?.[0] && item.viewItemURL?.[0])
    .map((item) => {
      const currentPrice = item.sellingStatus?.[0]?.currentPrice?.[0];
      const itemId = item.itemId?.[0];
      const condition = item.condition?.[0]?.conditionDisplayName?.[0];
      const productUrl = item.viewItemURL?.[0] || '';

      return {
        source: 'ebay-finding-api',
        merchantSlug: merchant.slug,
        merchantName: merchant.name,
        productName: item.title?.[0] || 'eBay item',
        category: item.primaryCategory?.[0]?.categoryName?.[0] || 'Marketplace',
        specifications: {
          ...(condition ? { Condition: condition } : {}),
        },
        imageUrl: item.galleryURL?.[0],
        productUrl,
        affiliateUrl: productUrl,
        price: toNumber(currentPrice?.__value__),
        currency: currentPrice?.['@currencyId'] || 'USD',
        availability: 'in_stock',
        condition: normalizeCondition(condition),
        sku: itemId,
        merchantSku: itemId,
        confidence: 'api',
      };
    });
}

function ebayFindingSortOrder(filters?: ProductSearchFilters) {
  if (filters?.sortBy === 'price_asc') return 'PricePlusShippingLowest';
  if (filters?.sortBy === 'price_desc') return 'CurrentPriceHighest';
  return process.env.EBAY_FINDING_SORT_ORDER || 'BestMatch';
}

async function getEbayAccessToken() {
  const clientId = getEbayClientId();
  const clientSecret = getEbayClientSecret();
  if (!clientId || !clientSecret) {
    if (process.env.EBAY_OAUTH_TOKEN) {
      return process.env.EBAY_OAUTH_TOKEN;
    }

    throw new Error('Missing eBay credentials. Set EBAY_OAUTH_TOKEN or EBAY_CLIENT_ID + EBAY_CLIENT_SECRET.');
  }

  if (ebayApplicationTokenCache && ebayApplicationTokenCache.expiresAt > Date.now() + 60_000) {
    return ebayApplicationTokenCache.accessToken;
  }

  const scope = process.env.EBAY_SCOPE || 'https://api.ebay.com/oauth/api_scope';
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope,
  });

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    cache: 'no-store',
  });

  const payload = (await response.json()) as EbayTokenResponse;
  if (!response.ok || !payload.access_token) {
    const message = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`eBay token request failed: ${message}`);
  }

  ebayApplicationTokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max((payload.expires_in || 7200) - 120, 60) * 1000,
  };

  return ebayApplicationTokenCache.accessToken;
}

function getEbayClientId() {
  return process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID || '';
}

function getEbayClientSecret() {
  return process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CERT_ID || '';
}

type ImpactCatalogItem = Record<string, unknown>;

async function searchImpact(
  keyword: string,
  filters?: ProductSearchFilters,
  options: ImpactSearchOptions = {},
): Promise<ProductSearchResult[]> {
  const accountSid = process.env.IMPACT_ACCOUNT_SID || '';
  const authToken = process.env.IMPACT_AUTH_TOKEN || '';
  const endpoint =
    options.endpoint ||
    process.env.IMPACT_PRODUCT_SEARCH_URL ||
    `https://api.impact.com/Mediapartners/${encodeURIComponent(accountSid)}/Catalogs/ItemSearch`;
  const pageSize =
    options.pageSize ||
    numberFromEnv('IMPACT_LIMIT', filters ? 100 : 25);

  const params = new URLSearchParams({
    Keyword: keyword,
    PageSize: String(Math.min(Math.max(Math.floor(pageSize), 1), 100)),
  });
  const impactQuery = buildImpactQuery(keyword, filters, options.query);
  if (impactQuery) params.set('Query', impactQuery);
  if (options.campaignId) params.set('CampaignId', options.campaignId);
  if (options.catalogId) params.set('CatalogId', options.catalogId);
  if (process.env.IMPACT_SORT_BY) params.set('SortBy', process.env.IMPACT_SORT_BY);

  const response = await fetch(`${endpoint}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(options.timeoutMs || providerTimeoutMs('IMPACT_TIMEOUT_MS', 12_000)),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  return impactItemsFromPayload(payload)
    .map((item) => mapImpactItem(item))
    .filter((item): item is ProductSearchResult => Boolean(item));
}

async function searchWalmartImpact(
  keyword: string,
  merchant: Merchant,
  filters?: ProductSearchFilters,
): Promise<ProductSearchResult[]> {
  const results = await searchImpact(keyword, filters, {
    campaignId: process.env.IMPACT_WALMART_CAMPAIGN_ID,
    catalogId: process.env.IMPACT_WALMART_CATALOG_ID,
    endpoint: process.env.IMPACT_WALMART_PRODUCT_SEARCH_URL,
    pageSize: numberFromEnv('IMPACT_WALMART_LIMIT', 25),
    query: process.env.IMPACT_WALMART_QUERY,
    timeoutMs: providerTimeoutMs('IMPACT_WALMART_TIMEOUT_MS', 15_000),
  });

  return results
    .filter((item) => matchesWalmartImpactItem(item))
    .map((item) => normalizeStoreSpecificResult(item, merchant, keyword));
}

function hasImpactConfig() {
  return Boolean(process.env.IMPACT_ACCOUNT_SID && process.env.IMPACT_AUTH_TOKEN);
}

function providerTimeoutMs(envKey: string, fallback: number) {
  const value = Number(process.env[envKey]);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 60_000) : fallback;
}

function numberFromEnv(envKey: string, fallback: number) {
  const value = Number(process.env[envKey]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function impactItemsFromPayload(payload: unknown): ImpactCatalogItem[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  for (const key of ['Items', 'CatalogItems', 'ItemSearchResults', 'Results', 'data']) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }

  return payload.Name || payload.CatalogItemId || payload.Id ? [payload] : [];
}

function mapImpactItem(item: ImpactCatalogItem): ProductSearchResult | null {
  const productName = stringField(item, ['Name', 'Title', 'ProductName']);
  const productUrl = urlField(item, ['Url', 'ProductUrl', 'ProductURL', 'MobileUrl', 'LandingPageUrl']);
  if (!productName || !productUrl) return null;

  const advertiserName = stringField(item, ['AdvertiserName', 'Advertiser', 'BrandName', 'CampaignName']) || 'Impact';
  const catalogItemId = stringField(item, ['CatalogItemId', 'Id', 'Sku', 'SKU', 'ProductId']);
  const currentPrice = numberField(item, ['CurrentPrice', 'Price', 'SalePrice']);
  const originalPrice = numberField(item, ['OriginalPrice', 'RetailPrice', 'ListPrice', 'WasPrice']);
  const labels = stringArrayField(item, ['Labels', 'Categories', 'Category']);
  const category = stringField(item, ['Category', 'ProductCategory']) || labels[0] || 'Marketplace';
  const affiliateUrl =
    urlField(item, ['TrackingURL', 'TrackingUrl', 'TrackingLink', 'TrackingLinkUrl', 'ClickUrl', 'AffiliateUrl']) ||
    productUrl;
  const featureBullets = Array.from(new Set([
    ...stringArrayField(item, ['Features', 'Highlights', 'Bullets']),
    ...walmartKeyItemFeatures(item),
  ])).slice(0, 20);

  return {
    source: 'impact-catalog-api',
    merchantSlug: slugify(advertiserName),
    merchantName: advertiserName,
    productName,
    brand: stringField(item, ['Manufacturer', 'Brand', 'BrandName']),
    category,
    shortDescription: descriptionField(item, ['ShortDescription', 'Description', 'ProductDescription', 'Product Description']),
    description: descriptionField(item, [
      'LongDescription',
      'Description',
      'ProductDescription',
      'Product Description',
      'ProductDetails',
      'Product Details',
      'product_details',
      'MoreDetails',
      'More Details',
      'more_details',
    ]),
    featureBullets,
    specifications: productSpecsFromRecords(item),
    imageUrl: urlField(item, ['ImageUrl', 'ImageURL', 'Image', 'ThumbnailUrl']),
    productUrl,
    affiliateUrl,
    price: currentPrice,
    originalPrice,
    currency: stringField(item, ['Currency']) || 'USD',
    availability: normalizeImpactAvailability(stringField(item, ['StockAvailability', 'Availability'])),
    condition: 'new',
    gtin: stringField(item, ['Gtin', 'GTIN', 'Upc', 'UPC', 'Ean', 'EAN']),
    mpn: stringField(item, ['Mpn', 'MPN', 'ManufacturerPartNumber']),
    sku: catalogItemId ? `impact-${catalogItemId}`.slice(0, 100) : undefined,
    merchantSku: stringField(item, ['CatalogItemId', 'Sku', 'SKU', 'ProductId']) || catalogItemId,
    confidence: 'api',
  };
}

function isRecord(value: unknown): value is ImpactCatalogItem {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(item: ImpactCatalogItem, keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function stringArrayField(item: ImpactCatalogItem, keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function numberField(item: ImpactCatalogItem, keys: string[]) {
  const value = stringField(item, keys);
  if (!value) return undefined;
  const number = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

function urlField(item: ImpactCatalogItem, keys: string[]) {
  const value = stringField(item, keys);
  if (!value) return undefined;
  return value.startsWith('http://') || value.startsWith('https://') ? value : undefined;
}

function moneyField(item: ImpactCatalogItem, keys: string[]) {
  const value = stringField(item, keys);
  if (!value) return undefined;
  const number = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

function descriptionField(item: ImpactCatalogItem, keys: string[]) {
  for (const key of keys) {
    const value = descriptionTextFromValue(item[key]);
    if (value) return value.slice(0, 5000);
  }
  return undefined;
}

function descriptionTextFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') return cleanDescriptionText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => descriptionTextFromValue(entry))
      .filter(Boolean)
      .join('\n\n');
    return cleanDescriptionText(text);
  }
  if (isRecord(value)) {
    return descriptionField(value, [
      'Product Description',
      'product_description',
      'description',
      'Description',
      'text',
      'content',
    ]);
  }
  return undefined;
}

function cleanDescriptionText(value?: string) {
  if (!value) return undefined;
  return (
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || undefined
  );
}

function amazonShortDescriptionFromDetail(item: ImpactCatalogItem) {
  return (
    descriptionField(item, ['short_description', 'snippet', 'product_description', 'description']) ||
    stringField(item, ['product_title', 'title', 'name']) ||
    stringArrayField(item, ['about_product', 'features', 'feature_bullets'])[0]
  );
}

function amazonDescriptionFromDetail(item: ImpactCatalogItem) {
  const direct = descriptionField(item, ['description', 'product_description', 'aplus_text']);
  if (direct) return direct;

  const bullets = stringArrayField(item, ['about_product', 'features', 'feature_bullets'])
    .map((entry) => cleanDescriptionText(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (!bullets.length) return undefined;

  return bullets.slice(0, 10).map((entry) => `- ${entry}`).join('\n');
}

function amazonAsinPriceFromDetail(item: ImpactCatalogItem) {
  const price = isRecord(item.price) ? item.price : undefined;
  return price ? numberField(price, ['value', 'price', 'amount']) : undefined;
}

function amazonAsinListPriceFromDetail(item: ImpactCatalogItem) {
  const price = isRecord(item.price) ? item.price : undefined;
  return (price ? numberField(price, ['list_price', 'original_price', 'was_price']) : undefined) ||
    moneyField(item, ['originalPrice', 'original_price', 'was_price']);
}

function amazonAvailabilityFromDetail(item: ImpactCatalogItem, fallback: ProductSearchResult['availability']) {
  if (typeof item.in_stock === 'boolean') return item.in_stock ? 'in_stock' : 'out_of_stock';
  if (typeof item.inStock === 'boolean') return item.inStock ? 'in_stock' : 'out_of_stock';
  return fallback;
}

function amazonIdentifiersFromDetail(
  detail: ImpactCatalogItem,
  productInformation: ImpactCatalogItem,
  item: ProductSearchResult,
  fallbackAsin?: string,
) {
  const records = [detail, productInformation];
  const asin = validAsin(firstStringField(records, ['asin', 'ASIN', 'product_asin', 'Product ASIN'])) || fallbackAsin || item.asin;
  const ean = firstStringField(records, ['ean', 'EAN', 'Ean', 'gtin', 'GTIN', 'upc', 'UPC', 'barcode', 'Barcode']);
  const sku = firstStringField(records, ['sku', 'SKU', 'Sku', 'product_sku', 'Product SKU', 'seller_sku', 'Seller SKU', 'merchant_sku']);

  return {
    asin,
    ean,
    gtin: ean,
    sku,
    merchantSku: asin || sku,
  };
}

function amazonIdentifierSpecs(identifiers: {
  asin?: string;
  ean?: string;
  gtin?: string;
  sku?: string;
  merchantSku?: string;
}) {
  const specs: Record<string, string> = {};
  setSpec(specs, 'ASIN', identifiers.asin);
  setSpec(specs, 'EAN', identifiers.ean);
  setSpec(specs, 'GTIN', identifiers.gtin);
  setSpec(specs, 'SKU', identifiers.sku);
  return specs;
}

function firstStringField(records: ImpactCatalogItem[], keys: string[]) {
  for (const record of records.filter(Boolean)) {
    const value = stringField(record, keys);
    if (value) return value;
  }
  return undefined;
}

function productSpecsFromRecords(...records: ImpactCatalogItem[]) {
  const specs: Record<string, string | number | boolean | string[]> = {};
  const containers = [
    'specifications',
    'Specifications',
    'Specification',
    'product_specifications',
    'ProductSpecifications',
    'product_specs',
    'specs',
    'Specs',
    'technical_specs',
    'TechnicalSpecs',
    'attributes',
    'Attributes',
    'product_attributes',
    'ProductAttributes',
    'details',
    'Details',
    'more_details',
    'MoreDetails',
    'More Details',
    'product_details',
    'ProductDetails',
    'Product Details',
    'product_information',
    'ProductInformation',
    'productInformation',
    'product_info',
    'ProductInfo',
    'Product',
    'product',
    'additional_info',
    'AdditionalInfo',
    'item_specifics',
    'ItemSpecifics',
    'technical_details',
    'TechnicalDetails',
    'key_item_features',
    'KeyItemFeatures',
    'Key Item Features',
    'KeyFeatures',
  ];

  for (const record of records.filter(Boolean)) {
    for (const key of containers) {
      collectSpecsFromValue(record[key], specs);
    }

    setSpec(specs, 'Brand', stringField(record, ['brand', 'product_brand', 'manufacturer', 'Manufacturer', 'Brand']));
    setSpec(specs, 'Model', stringField(record, ['model', 'Model', 'model_number', 'ModelNumber']));
    setSpec(specs, 'Color', stringField(record, ['color', 'Color', 'colour']));
    setSpec(specs, 'ASIN', stringField(record, ['asin', 'ASIN', 'product_asin']));
    setSpec(specs, 'EAN', stringField(record, ['ean', 'EAN', 'Ean']));
    setSpec(specs, 'SKU', stringField(record, ['sku', 'SKU', 'Sku', 'product_sku', 'seller_sku', 'merchant_sku']));
    setSpec(specs, 'MPN', stringField(record, ['mpn', 'MPN', 'manufacturer_part_number', 'ManufacturerPartNumber']));
    setSpec(specs, 'GTIN', stringField(record, ['gtin', 'GTIN', 'upc', 'UPC', 'ean', 'EAN']));
    setSpec(specs, 'Condition', stringField(record, ['condition', 'product_condition']));
    setSpec(specs, 'Key item features', walmartKeyItemFeatures(record));
    setSpec(specs, 'More details', descriptionField(record, ['MoreDetails', 'More Details', 'more_details']));
    setSpec(specs, 'Product details', descriptionField(record, ['ProductDetails', 'Product Details', 'product_details']));
  }

  return Object.keys(specs).length ? specs : undefined;
}

function walmartKeyItemFeatures(item: ImpactCatalogItem) {
  const keys = [
    'KeyItemFeatures',
    'Key Item Features',
    'key_item_features',
    'KeyFeatures',
    'key_features',
    'Features',
    'Highlights',
  ];

  for (const key of keys) {
    const value = item[key];
    if (Array.isArray(value)) {
      const features = value
        .map((entry) => descriptionTextFromValue(entry))
        .filter((entry): entry is string => Boolean(entry));
      if (features.length) return features.slice(0, 20);
    }
    if (typeof value === 'string' && value.trim()) {
      const features = value
        .split(/\n|;|\u2022|,(?=\s*[A-Z0-9])/)
        .map((entry) => cleanDescriptionText(entry))
        .filter((entry): entry is string => Boolean(entry));
      if (features.length) return features.slice(0, 20);
    }
    if (isRecord(value)) {
      const text = descriptionTextFromValue(value);
      if (text) return [text];
    }
  }

  return [];
}

function ebayProductInformationFromDetail(detail: ImpactCatalogItem): unknown {
  for (const key of [
    'productInformation',
    'ProductInformation',
    'product_information',
    'product',
    'Product',
    'productDetails',
    'ProductDetails',
  ]) {
    const value = detail[key];
    if (value) return value;
  }

  const itemSpecifics = detail.ItemSpecifics;
  if (isRecord(itemSpecifics)) return itemSpecifics.NameValueList || itemSpecifics;
  return undefined;
}

function specsFromNameValueList(value: unknown) {
  const specs: Record<string, string | number | boolean | string[]> = {};
  const rows = Array.isArray(value) ? value : value ? [value] : [];

  rows.filter(isRecord).forEach((entry) => {
    const name = stringField(entry, ['name', 'Name', 'key', 'label']);
    const rawValue = entry.value ?? entry.Value ?? entry.values ?? entry.Values;
    const normalized = normalizeSpecValue(rawValue);
    setSpec(specs, name, normalized);
  });

  return specs;
}

function collectSpecsFromValue(value: unknown, specs: Record<string, string | number | boolean | string[]>) {
  if (!value) return;

  if (Array.isArray(value)) {
    const textItems = value
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => String(entry).trim());
    if (textItems.length) setSpec(specs, 'Features', textItems);

    value.filter(isRecord).forEach((entry) => {
      const label = stringField(entry, ['name', 'key', 'label', 'title', 'attribute', 'specification']);
      const rawValue =
        entry.value ??
        entry.display_value ??
        entry.displayValue ??
        entry.text ??
        entry.content ??
        entry.values;
      setSpec(specs, label, normalizeSpecValue(rawValue));
    });
    return;
  }

  if (!isRecord(value)) return;

  const label = stringField(value, ['name', 'key', 'label', 'title', 'attribute', 'specification']);
  if (label) {
    const rawValue =
      value.value ??
      value.display_value ??
      value.displayValue ??
      value.text ??
      value.content ??
      value.values;
    setSpec(specs, label, normalizeSpecValue(rawValue));
    return;
  }

  Object.entries(value).forEach(([key, rawValue]) => {
    setSpec(specs, key, normalizeSpecValue(rawValue));
  });
}

function normalizeSpecValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === 'string') {
    const cleaned = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => normalizeSpecValue(entry))
      .filter((entry): entry is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof entry))
      .map((entry) => String(entry));
    return items.length ? items : undefined;
  }
  return undefined;
}

function setSpec(
  specs: Record<string, string | number | boolean | string[]>,
  key?: string,
  value?: string | number | boolean | string[],
) {
  const cleanKey = cleanSpecKey(key);
  if (!cleanKey || value === undefined || value === '') return;
  if (Array.isArray(value) && value.length === 0) return;
  if (specs[cleanKey] !== undefined) return;
  specs[cleanKey] = value;
}

function cleanSpecKey(value?: string) {
  if (!value) return undefined;
  const key = value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!key || ['description', 'product description', 'url', 'image', 'thumbnail'].includes(key.toLowerCase())) {
    return undefined;
  }
  return key.slice(0, 80);
}

function normalizeImpactAvailability(value?: string): ProductSearchResult['availability'] {
  const availability = (value || '').toLowerCase();
  if (availability.includes('out')) return 'out_of_stock';
  if (availability.includes('pre')) return 'preorder';
  if (availability.includes('stock') || availability.includes('limited')) return 'in_stock';
  return 'unknown';
}

function normalizeAmazonAvailability(value?: string): ProductSearchResult['availability'] {
  const availability = (value || '').toLowerCase();
  if (availability.includes('unavailable') || availability.includes('out of stock')) return 'out_of_stock';
  if (availability.includes('pre-order') || availability.includes('preorder')) return 'preorder';
  if (
    availability.includes('in stock') ||
    availability.includes('left in stock') ||
    availability.includes('usually ships')
  ) {
    return 'in_stock';
  }
  return 'unknown';
}

function normalizeProductSearchAvailability(value?: string): ProductSearchResult['availability'] {
  const availability = (value || '').toLowerCase();
  if (availability.includes('out') || availability.includes('unavailable')) return 'out_of_stock';
  if (availability.includes('pre-order') || availability.includes('preorder')) return 'preorder';
  if (
    availability.includes('stock') ||
    availability.includes('delivery') ||
    availability.includes('pickup') ||
    availability.includes('shipping')
  ) {
    return 'in_stock';
  }
  return 'unknown';
}

function looksLikeProductSearchRecord(item: ProductSearchApiRecord) {
  return Boolean(
    stringField(item, ['product_title', 'title', 'name', 'product_name']) ||
      stringField(item, ['store_name', 'merchant_name', 'seller', 'seller_name']) ||
      urlField(item, ['offer_page_url', 'product_offer_page_url', 'product_page_url', 'url', 'link', 'product_url']),
  );
}

function dedupeRecords<T extends ProductSearchApiRecord>(records: T[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key =
      stringField(record, ['product_id', 'offer_id', 'id', 'item_id', 'url', 'link', 'offer_page_url', 'product_page_url']) ||
      JSON.stringify(record).slice(0, 500);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currencyFromMoneyText(value?: string) {
  if (!value) return undefined;
  const text = value.trim();
  if (text.includes('£')) return 'GBP';
  if (text.includes('€')) return 'EUR';
  if (text.includes('¥')) return 'JPY';
  if (/\bCAD\b|C\$/i.test(text)) return 'CAD';
  if (/\bAUD\b|A\$/i.test(text)) return 'AUD';
  if (/\bUSD\b|\$/i.test(text)) return 'USD';
  return undefined;
}

function currencyCodeFromSymbol(value?: string) {
  if (!value) return undefined;
  const text = value.trim();
  if (text === '$' || /\bUSD\b/i.test(text)) return 'USD';
  if (text === '£' || /\bGBP\b/i.test(text)) return 'GBP';
  if (text === '€' || /\bEUR\b/i.test(text)) return 'EUR';
  if (text === '¥' || /\bJPY\b/i.test(text)) return 'JPY';
  return /^[A-Z]{3}$/i.test(text) ? text.toUpperCase() : undefined;
}

function ratingFromText(value?: string) {
  const match = value?.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const rating = Number(match[1]);
  return Number.isFinite(rating) ? rating : undefined;
}

function merchantNameFromUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, '');
    const domain = hostname.split('.')[0];
    if (!domain || domain === 'google') return undefined;
    return titleCase(domain.replace(/[-_]+/g, ' '));
  } catch {
    return undefined;
  }
}

function merchantSlugForProductSearch(merchantName: string, productUrl: string) {
  const known = knownMerchantSlugFromUrl(productUrl);
  if (known) return known;
  return slugify(merchantName.replace(/\.(com|co\.uk|net|org)$/i, ''));
}

function matchesProductSearchMerchant(item: ProductSearchResult, merchant: Merchant) {
  if (item.merchantSlug === merchant.slug) return true;
  if (slugify(item.merchantName) === merchant.slug) return true;

  try {
    const itemHostname = new URL(item.productUrl).hostname.replace(/^www\./, '').toLowerCase();
    const merchantHostname = merchant.websiteUrl
      ? new URL(merchant.websiteUrl).hostname.replace(/^www\./, '').toLowerCase()
      : '';

    return Boolean(merchantHostname && (itemHostname === merchantHostname || itemHostname.endsWith(`.${merchantHostname}`)));
  } catch {
    return false;
  }
}

function isGoogleShoppingUrl(value?: string) {
  if (!value) return false;

  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    return hostname === 'google.com'
      || hostname.endsWith('.google.com')
      || hostname === 'shopping.google.com'
      || hostname.endsWith('.shopping.google.com')
      || hostname === 'googleadservices.com'
      || hostname.endsWith('.googleadservices.com');
  } catch {
    return false;
  }
}

function merchantSearchUrl(query: string, merchant: Merchant) {
  const encoded = encodeURIComponent(query.trim() || merchant.name);
  if (merchant.slug === 'amazon') return `https://www.amazon.com/s?k=${encoded}`;
  if (merchant.slug === 'walmart') return `https://www.walmart.com/search?q=${encoded}`;
  if (merchant.slug === 'target') return `https://www.target.com/s?searchTerm=${encoded}`;
  if (merchant.slug === 'newegg') return `https://www.newegg.com/p/pl?d=${encoded}`;
  if (merchant.slug === 'best-buy') return `https://www.bestbuy.com/site/searchpage.jsp?st=${encoded}`;
  if (merchant.slug === 'ebay') return `https://www.ebay.com/sch/i.html?_nkw=${encoded}`;
  return merchant.websiteUrl || '';
}

function knownMerchantSlugFromUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, '').toLowerCase();
    if (hostname === 'amzn.to' || hostname.includes('amazon.')) return 'amazon';
    if (hostname.endsWith('ebay.com')) return 'ebay';
    if (hostname.endsWith('walmart.com')) return 'walmart';
    if (hostname.endsWith('target.com')) return 'target';
    if (hostname.endsWith('bestbuy.com')) return 'best-buy';
    if (hostname.endsWith('newegg.com') || hostname.endsWith('neweggbusiness.com')) return 'newegg';
    if (hostname.endsWith('aliexpress.com')) return 'aliexpress';
    if (hostname.endsWith('apple.com')) return 'apple';
    return undefined;
  } catch {
    return undefined;
  }
}

function amazonBrandFromByline(value?: string) {
  if (!value) return undefined;
  return value
    .replace(/^visit\s+the\s+/i, '')
    .replace(/\s+store$/i, '')
    .replace(/^brand:\s*/i, '')
    .trim() || undefined;
}

function asinFromUrl(value?: string) {
  if (!value) return undefined;
  return value.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase();
}

function buildImpactQuery(keyword: string, filters?: ProductSearchFilters, extraQuery?: string) {
  const clauses = [process.env.IMPACT_QUERY, extraQuery].filter(Boolean) as string[];
  const smartPhoneMinPrice =
    !filters?.minPrice && filters?.excludeAccessories !== false && isPhoneSearchKeyword(keyword) ? 75 : undefined;
  const minPrice = filters?.minPrice || smartPhoneMinPrice;
  if (minPrice) clauses.push(`CurrentPrice >= ${minPrice}`);
  return clauses.join(' AND ');
}

function matchesWalmartImpactItem(item: ProductSearchResult) {
  const text = normalizeForSearch([item.merchantName, item.productUrl, item.affiliateUrl, item.source].filter(Boolean).join(' '));
  return text.includes('walmart') || item.merchantSlug === 'walmart';
}

const accessoryTerms = [
  'case',
  'cases',
  'cover',
  'covers',
  'screen protector',
  'screen protectors',
  'protector',
  'tempered glass',
  'glass protector',
  'lens protector',
  'camera protector',
  'charger',
  'charging cable',
  'cable',
  'cord',
  'adapter',
  'wallet',
  'holster',
  'clip',
  'mount',
  'stand',
  'grip',
  'skin',
  'sticker',
  'bumper',
  'replacement battery',
  'digitizer',
  'lcd screen',
];

const phoneTerms = [
  'cell phone',
  'cell phones',
  'smartphone',
  'smartphones',
  'mobile phone',
  'mobile phones',
  'unlocked phone',
  'phone only',
];

const phoneModelTerms = [
  'iphone',
  'pixel',
  'galaxy',
  'motorola',
  'moto',
  'oneplus',
  'xperia',
  'nokia',
  'nothing phone',
  'smartphone',
];

function applySearchFilters(
  results: ProductSearchResult[],
  keyword: string,
  filters?: ProductSearchFilters,
) {
  const activeFilters = filters || {
    productType: 'all',
    productCondition: 'all',
    excludeAccessories: true,
    perMerchantLimit: 2,
    sortBy: 'relevance',
  };
  const smartPhoneMinPrice =
    !activeFilters.minPrice && activeFilters.excludeAccessories !== false && isPhoneSearchKeyword(keyword) ? 75 : undefined;
  const minPrice = activeFilters.minPrice || smartPhoneMinPrice;

  return results.filter((item) => {
    if (matchesExcludedKeyword(item, activeFilters.excludeKeyword)) {
      return false;
    }

    if (minPrice && !isPriceOptionalDiscoveryResult(item) && (item.price === undefined || item.price < minPrice)) {
      return false;
    }

    if (!matchesProductCondition(item, activeFilters.productCondition)) {
      return false;
    }

    const accessory = isAccessory(item);
    if (activeFilters.productType === 'accessories') return accessory;
    if (activeFilters.excludeAccessories && accessory) return false;
    if (activeFilters.productType === 'phones') return looksLikePhone(item, keyword);

    return true;
  });
}

function matchesProductCondition(item: ProductSearchResult, condition: ProductSearchFilters['productCondition']) {
  if (!condition) return true;
  if (condition === 'all') return true;
  if (condition === 'new') return item.condition === 'new';
  return item.condition === 'refurbished' || item.condition === 'open_box';
}

function isPriceOptionalDiscoveryResult(item: ProductSearchResult) {
  return item.source === 'amazon-product-search-discovery';
}

function matchesExcludedKeyword(item: ProductSearchResult, keyword?: string) {
  const needle = normalizeForSearch(keyword || '');
  if (!needle) return false;
  const haystack = normalizeForSearch([
    item.productName,
    item.brand,
    item.category,
    item.shortDescription,
    item.description,
    item.merchantName,
    item.condition,
    ...(item.featureBullets || []),
  ].filter(Boolean).join(' '));
  return haystack.includes(needle);
}

function limitPerMerchant(results: ProductSearchResult[], limit: number) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 2;
  const counts = new Map<string, number>();

  return results.filter((item) => {
    const key = item.merchantSlug || item.merchantName;
    const count = counts.get(key) ?? 0;
    if (count >= max) return false;
    counts.set(key, count + 1);
    return true;
  });
}

function interleaveMerchantResults(results: ProductSearchResult[]) {
  const buckets = new Map<string, ProductSearchResult[]>();

  results.forEach((item) => {
    const key = item.merchantSlug || item.merchantName;
    buckets.set(key, [...(buckets.get(key) || []), item]);
  });

  const interleaved: ProductSearchResult[] = [];
  while (buckets.size) {
    for (const [key, bucket] of buckets) {
      const next = bucket.shift();
      if (next) interleaved.push(next);
      if (!bucket.length) buckets.delete(key);
    }
  }

  return interleaved;
}

function relevanceScore(
  item: ProductSearchResult,
  keyword: string,
  filters?: ProductSearchFilters,
) {
  const text = searchableText(item);
  const normalizedKeyword = normalizeForSearch(keyword);
  const tokens = keywordTokens(keyword);
  let score = 0;

  if (text.includes(normalizedKeyword)) score += 80;
  score += tokens.filter((token) => text.includes(token)).length * 8;
  if (looksLikePhone(item, keyword)) score += 25;
  if (hasAnyPhrase(text, phoneTerms)) score += 18;
  if (item.availability === 'in_stock') score += 5;
  if (item.confidence !== 'demo') score += 4;

  const accessory = isAccessory(item);
  if (accessory) score -= filters?.excludeAccessories === false ? 8 : 80;
  if (filters?.productType === 'accessories' && accessory) score += 60;
  if (filters?.productType === 'phones' && !accessory) score += 30;

  return score;
}

function priceForSort(item: ProductSearchResult) {
  return item.price ?? Number.MAX_SAFE_INTEGER;
}

function looksLikePhone(item: ProductSearchResult, keyword: string) {
  const text = searchableText(item);
  if (isAccessory(item)) return false;
  if (hasAnyPhrase(text, phoneTerms)) return true;
  if (hasAnyPhrase(text, phoneModelTerms) && hasAnyKeywordToken(item, keyword)) return true;
  if ((item.price ?? 0) >= 100 && hasAnyKeywordToken(item, keyword)) return true;
  return false;
}

function isPhoneSearchKeyword(keyword: string) {
  return hasAnyPhrase(normalizeForSearch(keyword), phoneModelTerms) || hasAnyPhrase(normalizeForSearch(keyword), phoneTerms);
}

function isAccessory(item: ProductSearchResult) {
  return hasAnyPhrase(searchableText(item), accessoryTerms);
}

function hasAnyKeywordToken(item: ProductSearchResult, keyword: string) {
  const text = searchableText(item);
  return keywordTokens(keyword).some((token) => text.includes(token));
}

function keywordTokens(keyword: string) {
  return normalizeForSearch(keyword)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !['for', 'and', 'the', 'with'].includes(token));
}

function searchableText(item: ProductSearchResult) {
  return normalizeForSearch([item.productName, item.brand, item.category, item.merchantName].filter(Boolean).join(' '));
}

function normalizeForSearch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasAnyPhrase(text: string, phrases: string[]) {
  return phrases.some((phrase) => {
    const normalized = normalizeForSearch(phrase);
    return new RegExp(`(^| )${escapeRegExp(normalized)}( |$)`).test(text);
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maybeDemo(keyword: string, merchant: Merchant): Promise<ProductSearchResult[]> {
  return showDemoResults() ? searchMerchantDemo(keyword, merchant) : Promise.resolve([]);
}

function showDemoResults() {
  return process.env.SHOW_DEMO_RESULTS === 'true';
}

async function searchMerchantDemo(keyword: string, merchant: Merchant): Promise<ProductSearchResult[]> {
  const hint = merchantHints[merchant.slug] || {
    category: 'General',
    domain: merchant.websiteUrl ? new URL(merchant.websiteUrl).hostname.replace(/^www\./, '') : `${merchant.slug}.com`,
    currency: 'USD',
  };
  const base = deterministicPrice(keyword, merchant.slug);
  const productSlug = slugify(keyword);

  return [0, 1, 2].map((index) => {
    const price = Math.round((base + index * 7.25) * 100) / 100;
    const originalPrice = Math.round(price * (1.12 + index * 0.07) * 100) / 100;
    return {
      source: 'demo-provider',
      merchantSlug: merchant.slug,
      merchantName: merchant.name,
      productName: `${titleCase(keyword)} ${index === 0 ? 'Deal' : index === 1 ? 'Value Pack' : 'Top Rated'}`,
      brand: inferBrand(keyword),
      category: hint.category,
      imageUrl: `https://placehold.co/640x480/f8fafc/0f172a?text=${encodeURIComponent(merchant.name)}`,
      productUrl: `https://www.${hint.domain}/search?q=${encodeURIComponent(keyword)}&nxt_demo=${index + 1}`,
      affiliateUrl: `https://www.${hint.domain}/search?q=${encodeURIComponent(keyword)}&utm_source=nxt-bargains&nxt_demo=${index + 1}`,
      price,
      originalPrice,
      currency: hint.currency,
      availability: 'in_stock',
      condition: 'new',
      sku: `${merchant.slug.toUpperCase()}-${productSlug}-${index + 1}`.slice(0, 100),
      merchantSku: `${merchant.slug}-${productSlug}-${index + 1}`.slice(0, 100),
      rating: Math.round((4.1 + index * 0.2) * 10) / 10,
      ratingCount: 150 + index * 83,
      confidence: 'demo',
    };
  });
}

function toNumber(value?: string) {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeCondition(value?: string): ProductSearchResult['condition'] {
  const condition = (value || '').toLowerCase();
  if (condition.includes('renew') || condition.includes('refurb')) return 'refurbished';
  if (condition.includes('new')) return 'new';
  if (condition.includes('open')) return 'open_box';
  if (condition.includes('used') || condition.includes('pre-owned')) return 'used';
  return 'unknown';
}

function deterministicPrice(keyword: string, merchantSlug: string) {
  const seed = `${keyword}:${merchantSlug}`.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return 18 + (seed % 130);
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function inferBrand(keyword: string) {
  const first = keyword.trim().split(/\s+/)[0];
  if (!first || first.length < 3) return undefined;
  return titleCase(first);
}
