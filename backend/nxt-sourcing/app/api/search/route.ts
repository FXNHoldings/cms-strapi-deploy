import { NextResponse } from 'next/server';
import { getCommerceMerchants } from '@/lib/merchants';
import { searchAllProviders } from '@/lib/providers';
import type { ProductSearchFilters } from '@/lib/types';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  const merchantSlugs = Array.isArray(body.merchants) ? body.merchants.filter(Boolean) : [];
  const filters = searchFiltersFromBody(body.filters);

  if (keyword.length < 2) {
    return NextResponse.json({ error: 'Enter at least 2 characters.' }, { status: 400 });
  }

  const allMerchants = await getCommerceMerchants();
  const selected = merchantSlugs.length
    ? allMerchants.filter((merchant) => merchantSlugs.includes(merchant.slug))
    : allMerchants.slice(0, 5);

  const results = await searchAllProviders({ keyword, merchants: selected, filters });
  const hasLiveResults = results.some((item) => item.confidence !== 'demo');
  const hasDemoResults = results.some((item) => item.confidence === 'demo');
  const selectedSlugs = new Set(selected.map((merchant) => merchant.slug));
  return NextResponse.json({
    mode: hasLiveResults && hasDemoResults ? 'mixed' : hasLiveResults ? 'live' : hasDemoResults ? 'demo' : 'empty',
    message: hasLiveResults && hasDemoResults
      ? 'Live provider results are included. Demo fallback may still appear where enabled.'
      : hasLiveResults
        ? 'Live provider results are shown.'
        : hasDemoResults
          ? 'Demo provider results. Add real merchant API credentials to enable live merchant search.'
          : emptyResultsMessage(selectedSlugs),
    results,
  });
}

function emptyResultsMessage(selectedSlugs: Set<string>) {
  const checks = [];
  if (selectedSlugs.has('amazon')) {
    checks.push('Amazon Product Info2 response/filters');
  }
  if (selectedSlugs.has('walmart')) {
    checks.push('Walmart Impact settings');
  }
  if (selectedSlugs.has('ebay')) {
    checks.push('eBay credentials');
  }
  if (['target', 'newegg', 'best-buy'].some((slug) => selectedSlugs.has(slug))) {
    checks.push('RapidAPI Product Search key/timeouts');
  }
  return checks.length
    ? `No live results found. Check ${checks.join(', ')}.`
    : 'No live results found. Check the selected merchant API credentials.';
}

function searchFiltersFromBody(value: unknown): ProductSearchFilters {
  const filters = isRecord(value) ? value : {};
  const productType = filters.productType;
  const productCondition = filters.productCondition;
  const excludeKeyword = typeof filters.excludeKeyword === 'string' ? filters.excludeKeyword.trim() : '';
  const minPrice = Number(filters.minPrice);
  const perMerchantLimit = Number(filters.perMerchantLimit);

  return {
    productType: productType === 'phones' || productType === 'accessories' ? productType : 'all',
    productCondition:
      productCondition === 'new' || productCondition === 'renewed'
        ? productCondition
        : 'all',
    excludeKeyword: excludeKeyword || undefined,
    minPrice: Number.isFinite(minPrice) && minPrice > 0 ? minPrice : undefined,
    excludeAccessories: filters.excludeAccessories !== false,
    perMerchantLimit:
      Number.isFinite(perMerchantLimit) && perMerchantLimit > 0
        ? Math.min(Math.floor(perMerchantLimit), 50)
        : 2,
    sortBy:
      filters.sortBy === 'price_asc' || filters.sortBy === 'price_desc'
        ? filters.sortBy
        : 'relevance',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
