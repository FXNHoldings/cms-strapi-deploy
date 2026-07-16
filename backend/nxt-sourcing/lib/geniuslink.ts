import type { ProductSearchResult } from './types';

type GeniuslinkShortUrl = {
  code?: string;
  baseCode?: string;
  domain?: string;
  baseDomain?: string;
  productUrl?: string;
};

type GeniuslinkCreateResponse = {
  shortUrl?: GeniuslinkShortUrl;
};

export type GeniuslinkGroup = {
  id: number;
  name?: string;
  description?: string;
  userName?: string;
  enabled?: number;
};

type GeniuslinkGroupsResponse = {
  groups?: GeniuslinkGroup[];
};

export type GeniuslinkCreateInput = {
  url: string;
  note?: string;
  vanityCode?: string;
  groupId?: number;
  domain?: string;
};

export type GeniuslinkCreateResult = {
  affiliateUrl: string;
  shortUrl: GeniuslinkShortUrl;
};

const DEFAULT_GENIUSLINK_MERCHANTS = ['amazon', 'target', 'newegg', 'walmart', 'best-buy'];

export function hasGeniuslinkConfig() {
  return Boolean(process.env.GENIUSLINK_API_KEY && process.env.GENIUSLINK_API_SECRET);
}

export async function maybeCreateGeniuslinkUrl(item: ProductSearchResult): Promise<ProductSearchResult> {
  if (!hasGeniuslinkConfig() || !shouldAutoCreateForItem(item)) return item;

  const existingAffiliateUrl = item.affiliateUrl || '';
  if (
    existingAffiliateUrl &&
    existingAffiliateUrl !== item.productUrl &&
    process.env.GENIUSLINK_FORCE_CREATE !== 'true'
  ) {
    return item;
  }

  const result = await createGeniuslinkShortUrl({
    url: item.productUrl,
    note: geniuslinkNoteForItem(item),
  });

  return {
    ...item,
    affiliateUrl: result.affiliateUrl,
  };
}

export async function createGeniuslinkShortUrl(input: GeniuslinkCreateInput): Promise<GeniuslinkCreateResult> {
  const key = process.env.GENIUSLINK_API_KEY || '';
  const secret = process.env.GENIUSLINK_API_SECRET || '';
  if (!key || !secret) {
    throw new Error('GENIUSLINK_API_KEY and GENIUSLINK_API_SECRET are required.');
  }

  const params = new URLSearchParams({
    url: input.url,
    note: input.note || '',
    fetchMetadata: process.env.GENIUSLINK_FETCH_METADATA === 'false' ? 'false' : 'true',
  });

  const groupId = input.groupId ?? numericEnv('GENIUSLINK_GROUP_ID');
  if (!groupId) {
    throw new Error('GENIUSLINK_GROUP_ID is required. Use /api/geniuslink/groups to list available groups.');
  }
  params.set('groupId', String(groupId));

  const domain = normalizeGeniuslinkDomain(input.domain || process.env.GENIUSLINK_DOMAIN);
  if (domain && domain !== 'geni.us') params.set('domain', domain);
  if (input.vanityCode) params.set('vanityCode', input.vanityCode);

  const response = await fetch(`https://api.geni.us/v3/shorturls?${params.toString()}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': key,
      'X-Api-Secret': secret,
      ...(process.env.GENIUSLINK_IMPERSONATE ? { 'X-Impersonate': process.env.GENIUSLINK_IMPERSONATE } : {}),
    },
    body: JSON.stringify({}),
    cache: 'no-store',
  });

  const payload = (await response.json().catch(() => ({}))) as GeniuslinkCreateResponse & Record<string, unknown>;
  if (!response.ok || !payload.shortUrl) {
    throw new Error(`Geniuslink create failed: HTTP ${response.status} ${errorText(payload)}`);
  }

  const affiliateUrl = affiliateUrlFromShortUrl(payload.shortUrl);
  if (!affiliateUrl) {
    throw new Error('Geniuslink create failed: response did not include a short URL code.');
  }

  return {
    affiliateUrl,
    shortUrl: payload.shortUrl,
  };
}

export async function listGeniuslinkGroups(): Promise<GeniuslinkGroup[]> {
  const payload = (await geniuslinkFetch('/v1/groups/list')) as GeniuslinkGroupsResponse;
  return Array.isArray(payload.groups) ? payload.groups : [];
}

async function geniuslinkFetch(path: string) {
  const key = process.env.GENIUSLINK_API_KEY || '';
  const secret = process.env.GENIUSLINK_API_SECRET || '';
  if (!key || !secret) {
    throw new Error('GENIUSLINK_API_KEY and GENIUSLINK_API_SECRET are required.');
  }

  const response = await fetch(`https://api.geni.us${path}`, {
    headers: {
      Accept: 'application/json',
      'X-Api-Key': key,
      'X-Api-Secret': secret,
      ...(process.env.GENIUSLINK_IMPERSONATE ? { 'X-Impersonate': process.env.GENIUSLINK_IMPERSONATE } : {}),
    },
    cache: 'no-store',
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Geniuslink request failed: HTTP ${response.status} ${errorText(payload)}`);
  }
  return payload;
}

function shouldAutoCreateForItem(item: ProductSearchResult) {
  if (process.env.GENIUSLINK_AUTO_CREATE === 'false') return false;
  return geniuslinkMerchantSlugs().includes(item.merchantSlug);
}

function geniuslinkMerchantSlugs() {
  return (process.env.GENIUSLINK_MERCHANT_SLUGS || DEFAULT_GENIUSLINK_MERCHANTS.join(','))
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
}

function geniuslinkNoteForItem(item: ProductSearchResult) {
  return `NXT.Bargains ${item.merchantName}: ${item.productName}`.slice(0, 240);
}

function affiliateUrlFromShortUrl(shortUrl: GeniuslinkShortUrl) {
  const code = shortUrl.code || shortUrl.baseCode;
  const domain = shortUrl.domain || shortUrl.baseDomain || normalizeGeniuslinkDomain(process.env.GENIUSLINK_DOMAIN) || 'geni.us';
  if (!code) return undefined;
  return `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/${code}`;
}

function normalizeGeniuslinkDomain(value?: string) {
  if (!value) return undefined;
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function numericEnv(key: string) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function errorText(payload: Record<string, unknown>) {
  const responseStatus = payload.responseStatus;
  if (responseStatus && typeof responseStatus === 'object' && 'message' in responseStatus) {
    return String((responseStatus as { message?: unknown }).message || '');
  }
  return JSON.stringify(payload);
}
