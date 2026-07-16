export type Merchant = {
  name: string;
  slug: string;
  websiteUrl?: string;
  active?: boolean;
};

export type ProductSearchResult = {
  source: string;
  merchantSlug: string;
  merchantName: string;
  productName: string;
  brand?: string;
  category?: string;
  shortDescription?: string;
  description?: string;
  featureBullets?: string[];
  specifications?: Record<string, string | number | boolean | string[]>;
  imageUrl?: string;
  productUrl: string;
  affiliateUrl?: string;
  price?: number;
  originalPrice?: number;
  currency: string;
  availability: 'in_stock' | 'out_of_stock' | 'preorder' | 'unknown';
  condition: 'new' | 'used' | 'refurbished' | 'open_box' | 'unknown';
  asin?: string;
  gtin?: string;
  mpn?: string;
  sku?: string;
  merchantSku?: string;
  rating?: number;
  ratingCount?: number;
  confidence: 'demo' | 'api' | 'feed' | 'url-preview';
};

export type ProductSearchFilters = {
  productType: 'all' | 'phones' | 'accessories';
  productCondition?: 'all' | 'new' | 'renewed';
  excludeKeyword?: string;
  minPrice?: number;
  excludeAccessories: boolean;
  perMerchantLimit: number;
  sortBy: 'relevance' | 'price_asc' | 'price_desc';
};

export type AddToStrapiResult = {
  ok: boolean;
  dryRun: boolean;
  message: string;
  product?: unknown;
  offer?: unknown;
  snapshot?: unknown;
};
