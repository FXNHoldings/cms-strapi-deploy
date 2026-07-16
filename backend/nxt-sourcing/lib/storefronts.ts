// Storefronts the sourcing tool can import products into. Each imported product
// is tagged with its storefront key (alongside the legacy `nxt-sourcing` tag);
// each site's frontend filters products by `tags $containsi <key>`.
export const STOREFRONTS = [
  { key: 'nxt-bargains', label: 'NXT.Bargains' },
  { key: 'bestlooking-skin', label: 'BestLooking.Skin' },
  { key: 'nxtsmart-homes', label: 'NXTSmart.Homes' },
] as const;

export type StorefrontKey = (typeof STOREFRONTS)[number]['key'];

// Default keeps legacy behaviour (the tool was originally built for BestLooking.Skin).
export const DEFAULT_STOREFRONT: StorefrontKey = 'bestlooking-skin';

export function normalizeStorefront(value: unknown): StorefrontKey {
  return STOREFRONTS.some((s) => s.key === value) ? (value as StorefrontKey) : DEFAULT_STOREFRONT;
}
