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

export type StrapiDestination = {
  id: number;
  name: string;
  slug: string;
  type?: 'country' | 'region' | 'city';
  countryCode?: string;
  description?: string;
  heroImage?: StrapiImage;
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
  if (opts.category) filters.category = { slug: { $eq: opts.category } };
  if (opts.destination) filters.destinations = { slug: { $eq: opts.destination } };

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
    filters: { slug: { $eq: slug } },
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
