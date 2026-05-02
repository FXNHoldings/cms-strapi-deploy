import type { MetadataRoute } from 'next';
import {
  listArticles,
  listAirlines,
  listAirports,
  listCountries,
  listDestinations,
} from '@/lib/strapi';
import { SECTIONS } from '@/lib/sections';
import { LEGAL_DOCS } from '@/lib/legal';

const SITE_URL = 'https://www.originfacts.com';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const [articlesRes, destinations, airlines, airports, countries] = await Promise.all([
    listArticles({ pageSize: 200 }).catch(() => ({ data: [], meta: null as never })),
    listDestinations().catch(() => []),
    listAirlines().catch(() => []),
    listAirports().catch(() => []),
    listCountries().catch(() => []),
  ]);

  const articles = articlesRes.data;

  const staticPaths: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: 'daily', priority: 1.0 },
    { url: `${SITE_URL}/about`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE_URL}/contact`, lastModified: now, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${SITE_URL}/articles`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE_URL}/destinations`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${SITE_URL}/flights`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${SITE_URL}/hotels`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${SITE_URL}/airlines`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${SITE_URL}/airports`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${SITE_URL}/airports/hubs`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE_URL}/countries`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${SITE_URL}/sitemap`, lastModified: now, changeFrequency: 'weekly', priority: 0.4 },
  ];

  const categoryPaths: MetadataRoute.Sitemap = SECTIONS.map((s) => ({
    url: `${SITE_URL}/category/${s.slug}`,
    lastModified: now,
    changeFrequency: 'daily' as const,
    priority: 0.7,
  }));

  const articlePaths: MetadataRoute.Sitemap = articles.map((a) => ({
    url: `${SITE_URL}/articles/${a.slug}`,
    lastModified: a.updatedAt ? new Date(a.updatedAt) : (a.publishedAt ? new Date(a.publishedAt) : now),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  const destinationPaths: MetadataRoute.Sitemap = destinations
    .filter((d) => d.slug)
    .map((d) => ({
      url: `${SITE_URL}/destinations/${d.slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    }));

  const airlinePaths: MetadataRoute.Sitemap = airlines
    .filter((a) => a.slug)
    .map((a) => ({
      url: `${SITE_URL}/airlines/${a.slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    }));

  const airportPaths: MetadataRoute.Sitemap = airports
    .filter((a) => a.iata)
    .map((a) => ({
      url: `${SITE_URL}/airports/${a.iata.toLowerCase()}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    }));

  const countryPaths: MetadataRoute.Sitemap = countries
    .filter((c) => c.code)
    .map((c) => ({
      url: `${SITE_URL}/countries/${c.code.toLowerCase()}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    }));

  const legalPaths: MetadataRoute.Sitemap = LEGAL_DOCS.map((d) => ({
    url: `${SITE_URL}/legal/${d.slug}`,
    lastModified: now,
    changeFrequency: 'yearly' as const,
    priority: 0.3,
  }));

  return [
    ...staticPaths,
    ...categoryPaths,
    ...articlePaths,
    ...destinationPaths,
    ...airlinePaths,
    ...airportPaths,
    ...countryPaths,
    ...legalPaths,
  ];
}
