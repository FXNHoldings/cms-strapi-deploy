import { STRAPI_URL } from './config';
import type { Merchant } from './types';

type CommerceMerchantResponse = {
  name?: string;
  slug?: string;
  websiteUrl?: string;
  status?: string;
};

const fallbackMerchants: Merchant[] = [
  { name: 'Amazon', slug: 'amazon', websiteUrl: 'https://www.amazon.com', active: true },
  { name: 'eBay', slug: 'ebay', websiteUrl: 'https://www.ebay.com', active: true },
  { name: 'Walmart', slug: 'walmart', websiteUrl: 'https://www.walmart.com', active: true },
  { name: 'Newegg', slug: 'newegg', websiteUrl: 'https://www.newegg.com', active: true },
  { name: 'Target', slug: 'target', websiteUrl: 'https://www.target.com', active: true },
  { name: 'Best Buy', slug: 'best-buy', websiteUrl: 'https://www.bestbuy.com', active: true },
];

const allowedMerchantSlugs = ['amazon', 'ebay', 'walmart', 'newegg', 'target', 'best-buy'];

export async function getCommerceMerchants(): Promise<Merchant[]> {
  try {
    const response = await fetch(
      `${STRAPI_URL}/api/commerce-merchants?sort[0]=name:asc&pagination[pageSize]=100`,
      { next: { revalidate: 60 } },
    );
    if (!response.ok) return allowedMerchants(fallbackMerchants);
    const json = await response.json();
    const rows: CommerceMerchantResponse[] = Array.isArray(json?.data) ? json.data : [];
    const merchants: Merchant[] = rows
      .filter((item) => item?.status !== 'inactive')
      .map((item) => ({
        name: item.name || '',
        slug: item.slug || '',
        websiteUrl: item.websiteUrl,
        active: item.status !== 'inactive',
      }))
      .filter((item) => item.name && item.slug);

    return allowedMerchants(merchants.length ? merchants : fallbackMerchants);
  } catch {
    return allowedMerchants(fallbackMerchants);
  }
}

function allowedMerchants(merchants: Merchant[]) {
  return allowedMerchantSlugs
    .map((slug) => merchants.find((merchant) => merchant.slug === slug) || fallbackMerchants.find((merchant) => merchant.slug === slug))
    .filter((merchant): merchant is Merchant => Boolean(merchant));
}
