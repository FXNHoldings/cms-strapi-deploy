import qs from 'qs';

const BASE = (process.env.NEXT_PUBLIC_STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN;

export type StrapiImage = { url: string; alternativeText?: string; width?: number; height?: number } | null;

export type StrapiArticle = {
  id: number;
  documentId?: string;
  title: string;
  slug: string;
  excerpt?: string;
  content: string;
  readingTimeMinutes?: number;
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  publishedAt: string;
  updatedAt: string;
  coverImage?: StrapiImage;
  ogImage?: StrapiImage;
  category?: { id: number; name: string; slug: string; color?: string } | null;
  tags?: { id: number; name: string; slug: string }[];
  author?: { id: number; name: string; slug: string; avatar?: StrapiImage } | null;
  destinations?: { id: number; name: string; slug: string }[];
};

export type StrapiCategory = {
  id: number;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  color?: string;
  order?: number;
  site?: string;
  parent?: { id: number; name: string; slug: string } | null;
  children?: { id: number; name: string; slug: string }[];
};

export type StrapiCountry = {
  id: number;
  documentId?: string;
  code: string;
  name: string;
  currency?: string;
  region?: AirlineRegion;
  about?: string;
  heroImage?: StrapiImage;
};

export type StrapiDestination = {
  id: number;
  name: string;
  slug: string;
  type?: 'country' | 'region' | 'city';
  countryCode?: string;
  description?: string;
  heroImage?: StrapiImage;
};

export type AirlineType = 'Scheduled' | 'Charter' | 'Cargo' | 'Low-cost' | 'Regional';
export type AirlineRegion = 'Oceania' | 'Asia-Pacific' | 'Europe' | 'Americas' | 'Middle East' | 'Africa';

export type StrapiAirline = {
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  about?: string;
  iataCode?: string;
  icaoCode?: string;
  legalName?: string;
  type?: AirlineType;
  country?: string;
  airport?: string;
  city?: string;
  region?: AirlineRegion;
  founded?: number;
  logo?: StrapiImage;
  address?: string;
  phone?: string;
  website?: string;
};

export type StrapiAirport = {
  id: number;
  documentId?: string;
  iata: string;
  icao?: string;
  name: string;
  city?: string;
  country?: string;
  countryCode?: string;
  region?: AirlineRegion;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  about?: string;
  heroImage?: StrapiImage;
};

export type StrapiRoute = {
  id: number;
  documentId?: string;
  slug: string;
  origin?: StrapiAirport;
  destination?: StrapiAirport;
  carriers?: StrapiAirline[];
  distanceKm?: number;
  durationMinutes?: number;
  popularity?: number;
  about?: string;
};

type ListResponse<T> = { data: T[]; meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } } };

async function strapiFetch<T>(path: string, params?: Record<string, unknown>, revalidate = 60): Promise<T> {
  const query = params ? '?' + qs.stringify(params, { encodeValuesOnly: true }) : '';
  const url = `${BASE}/api/${path}${query}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    next: { revalidate },
  });
  if (!res.ok) {
    throw new Error(`Strapi ${res.status} on ${url}: ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

export function mediaUrl(img: StrapiImage): string | null {
  if (!img?.url) return null;
  return img.url.startsWith('http') ? img.url : `${BASE}${img.url}`;
}

export async function listArticles(opts: { page?: number; pageSize?: number; category?: string; destination?: string } = {}) {
  const filters: Record<string, unknown> = {};
  if (opts.category) filters.category = { slug: { $eqi: opts.category } };
  if (opts.destination) filters.destinations = { slug: { $eqi: opts.destination } };

  const res = await strapiFetch<ListResponse<StrapiArticle>>('articles', {
    sort: ['publishedAt:desc'],
    populate: ['coverImage', 'category', 'tags', 'author', 'destinations'],
    pagination: { page: opts.page ?? 1, pageSize: opts.pageSize ?? 12 },
    filters,
  });
  return res;
}

export async function getArticle(slug: string) {
  const res = await strapiFetch<ListResponse<StrapiArticle>>('articles', {
    filters: { slug: { $eq: slug } },
    populate: ['coverImage', 'ogImage', 'category', 'tags', 'author', 'author.avatar', 'destinations', 'gallery'],
    pagination: { pageSize: 1 },
  });
  return res.data?.[0] ?? null;
}

export async function listCategories(opts: { site?: string; topLevelOnly?: boolean } = {}) {
  const filters: Record<string, unknown> = {};
  if (opts.site) filters.site = { $in: ['all', opts.site] };
  if (opts.topLevelOnly) filters.parent = { id: { $null: true } };

  const res = await strapiFetch<ListResponse<StrapiCategory>>('categories', {
    sort: ['order:asc', 'name:asc'],
    populate: ['parent', 'children'],
    pagination: { pageSize: 100 },
    filters,
  });
  return res.data;
}

export async function getCategory(slug: string) {
  const res = await strapiFetch<ListResponse<StrapiCategory>>('categories', {
    filters: { slug: { $eqi: slug } },
    populate: ['parent', 'children'],
    pagination: { pageSize: 1 },
  });
  return res.data?.[0] ?? null;
}

export async function listDestinations() {
  const res = await strapiFetch<ListResponse<StrapiDestination>>('destinations', {
    sort: ['name:asc'],
    populate: ['heroImage'],
    pagination: { pageSize: 100 },
  });
  return res.data;
}

export async function getDestination(slug: string) {
  const res = await strapiFetch<ListResponse<StrapiDestination>>('destinations', {
    filters: { slug: { $eq: slug } },
    populate: ['heroImage'],
    pagination: { pageSize: 1 },
  });
  return res.data?.[0] ?? null;
}

export async function listAirlines() {
  const res = await strapiFetch<ListResponse<StrapiAirline>>('airlines', {
    sort: ['name:asc'],
    populate: ['logo'],
    pagination: { pageSize: 500 },
  });
  return res.data;
}

export async function getAirline(slug: string) {
  const res = await strapiFetch<ListResponse<StrapiAirline>>('airlines', {
    filters: { slug: { $eq: slug } },
    populate: ['logo'],
    pagination: { pageSize: 1 },
  });
  return res.data?.[0] ?? null;
}

export async function listAirports() {
  const res = await strapiFetch<ListResponse<StrapiAirport>>('airports', {
    sort: ['name:asc'],
    populate: ['heroImage'],
    pagination: { pageSize: 1000 },
  });
  return res.data;
}

export async function getAirport(iata: string) {
  const res = await strapiFetch<ListResponse<StrapiAirport>>('airports', {
    filters: { iata: { $eqi: iata } },
    populate: ['heroImage'],
    pagination: { pageSize: 1 },
  });
  return res.data?.[0] ?? null;
}

export async function listCountries() {
  const res = await strapiFetch<ListResponse<StrapiCountry>>('countries', {
    sort: ['name:asc'],
    populate: ['heroImage'],
    pagination: { pageSize: 500 },
  });
  return res.data;
}

export async function getCountry(code: string) {
  const res = await strapiFetch<ListResponse<StrapiCountry>>('countries', {
    filters: { code: { $eqi: code } },
    populate: ['heroImage'],
    pagination: { pageSize: 1 },
  });
  return res.data?.[0] ?? null;
}

export async function listAirportsByCountryCode(code: string, limit = 500) {
  const res = await strapiFetch<ListResponse<StrapiAirport>>('airports', {
    filters: { countryCode: { $eqi: code } },
    sort: ['name:asc'],
    populate: ['heroImage'],
    pagination: { pageSize: limit },
  });
  return res.data;
}

export async function listAirlinesByCountry(countryName: string, limit = 200) {
  const res = await strapiFetch<ListResponse<StrapiAirline>>('airlines', {
    filters: { country: { $eqi: countryName } },
    sort: ['name:asc'],
    populate: ['logo'],
    pagination: { pageSize: limit },
  });
  return res.data;
}

export async function listRoutesByCountryCode(code: string, limit = 20) {
  const res = await strapiFetch<ListResponse<StrapiRoute>>('routes', {
    filters: { destination: { countryCode: { $eqi: code } } },
    populate: {
      origin: true,
      destination: true,
      carriers: { populate: ['logo'] },
    },
    sort: ['popularity:desc'],
    pagination: { pageSize: limit },
  });
  return res.data;
}

export async function getRoute(slug: string) {
  const res = await strapiFetch<ListResponse<StrapiRoute>>('routes', {
    filters: { slug: { $eq: slug } },
    populate: {
      origin: { populate: ['heroImage'] },
      destination: { populate: ['heroImage'] },
      carriers: { populate: ['logo'] },
    },
    pagination: { pageSize: 1 },
  });
  return res.data?.[0] ?? null;
}

export async function listRoutes() {
  const res = await strapiFetch<ListResponse<StrapiRoute>>('routes', {
    sort: ['popularity:desc', 'slug:asc'],
    populate: {
      origin: true,
      destination: true,
      carriers: { populate: ['logo'] },
    },
    pagination: { pageSize: 1000 },
  });
  return res.data;
}

export async function listRoutesToDestination(
  dest: Pick<StrapiDestination, 'name' | 'countryCode' | 'type'>,
  limit = 12,
) {
  // Destinations aren't directly linked to routes in Strapi.
  // Match on the arrival airport: city for city-type destinations, countryCode otherwise.
  const filters: Record<string, unknown> =
    dest.type === 'city'
      ? { destination: { city: { $eqi: dest.name } } }
      : dest.countryCode
        ? { destination: { countryCode: { $eqi: dest.countryCode } } }
        : { destination: { country: { $eqi: dest.name } } };

  const res = await strapiFetch<ListResponse<StrapiRoute>>('routes', {
    filters,
    populate: {
      origin: true,
      destination: true,
      carriers: { populate: ['logo'] },
    },
    sort: ['popularity:desc'],
    pagination: { pageSize: limit },
  });
  return res.data;
}

export async function listRoutesByCarrier(airlineSlug: string, limit = 20) {
  const res = await strapiFetch<ListResponse<StrapiRoute>>('routes', {
    filters: { carriers: { slug: { $eq: airlineSlug } } },
    populate: {
      origin: true,
      destination: true,
      carriers: { populate: ['logo'] },
    },
    sort: ['popularity:desc'],
    pagination: { pageSize: limit },
  });
  return res.data;
}

export async function listRoutesFromAirport(iata: string, limit = 20) {
  const res = await strapiFetch<ListResponse<StrapiRoute>>('routes', {
    filters: { origin: { iata: { $eqi: iata } } },
    populate: {
      origin: true,
      destination: true,
      carriers: { populate: ['logo'] },
    },
    sort: ['popularity:desc'],
    pagination: { pageSize: limit },
  });
  return res.data;
}
