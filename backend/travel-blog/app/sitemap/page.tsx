import Link from 'next/link';
import type { Metadata } from 'next';
import {
  listArticles,
  listAirlines,
  listAirports,
  listCountries,
  listDestinations,
} from '@/lib/strapi';
import { SECTIONS } from '@/lib/sections';
import { LEGAL_DOCS } from '@/lib/legal';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Site Map',
  description: 'A complete index of every page on Originfacts — articles, destinations, airlines, airports, countries, categories, and policies.',
};

export default async function SitemapPage() {
  const [articlesRes, destinations, airlines, airports, countries] = await Promise.all([
    listArticles({ pageSize: 200 }).catch(() => ({ data: [], meta: null as never })),
    listDestinations().catch(() => []),
    listAirlines().catch(() => []),
    listAirports().catch(() => []),
    listCountries().catch(() => []),
  ]);

  const articles = articlesRes.data;
  const sortedDestinations = [...destinations].sort((a, b) => a.name.localeCompare(b.name));
  const sortedAirlines = [...airlines].sort((a, b) => a.name.localeCompare(b.name));
  const sortedAirports = [...airports]
    .filter((a) => a.iata)
    .sort((a, b) => a.iata.localeCompare(b.iata));
  const sortedCountries = [...countries].sort((a, b) => a.name.localeCompare(b.name));

  const linkClass = 'text-primary-emphasis hover:text-primary-highlight hover:underline';
  const sectionTitle = 'editorial-h text-2xl font-bold text-forest-900';

  return (
    <article className="mx-auto max-w-7xl px-6 py-16" data-testid="sitemap-page">
      <header className="max-w-3xl">
        <p className="chip">Site Map</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold leading-tight text-forest-900 sm:text-4xl">
          Site Map
        </h1>
        <p className="mt-3 text-lg text-forest-900/75">
          Every page on Originfacts, in one place. Looking for something a search engine can read?{' '}
          <a href="/sitemap.xml" className={linkClass}>View the XML sitemap</a>.
        </p>
      </header>

      <div className="mt-12 grid gap-12 lg:grid-cols-2">
        <section>
          <h2 className={sectionTitle}>Originfacts</h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li><Link href="/" className={linkClass}>Home</Link></li>
            <li><Link href="/about" className={linkClass}>About</Link></li>
            <li><Link href="/contact" className={linkClass}>Contact</Link></li>
            <li><Link href="/articles" className={linkClass}>All articles</Link></li>
          </ul>
        </section>

        <section>
          <h2 className={sectionTitle}>Topics</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.slug}>
                <Link href={`/category/${s.slug}`} className={linkClass}>{s.title}</Link>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className={sectionTitle}>Discover</h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li><Link href="/flights" className={linkClass}>Flights</Link></li>
            <li><Link href="/hotels" className={linkClass}>Hotels</Link></li>
            <li><Link href="/countries" className={linkClass}>Countries</Link></li>
            <li><Link href="/airlines" className={linkClass}>Airlines</Link></li>
            <li><Link href="/airports" className={linkClass}>Airports</Link></li>
            <li><Link href="/airports/hubs" className={linkClass}>International hubs</Link></li>
            <li><Link href="/destinations" className={linkClass}>Destinations</Link></li>
          </ul>
        </section>

        <section>
          <h2 className={sectionTitle}>Legal &amp; policies</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {LEGAL_DOCS.map((d) => (
              <li key={d.slug}>
                <Link href={`/legal/${d.slug}`} className={linkClass}>{d.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {articles.length > 0 && (
        <section className="mt-16">
          <h2 className={sectionTitle}>
            Articles <span className="text-base font-normal text-forest-900/60">({articles.length})</span>
          </h2>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {articles.map((a) => (
              <li key={a.id}>
                <Link href={`/articles/${a.slug}`} className={linkClass}>{a.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sortedDestinations.length > 0 && (
        <section className="mt-16">
          <h2 className={sectionTitle}>
            Destinations <span className="text-base font-normal text-forest-900/60">({sortedDestinations.length})</span>
          </h2>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {sortedDestinations.map((d) => (
              <li key={d.id}>
                <Link href={`/destinations/${d.slug}`} className={linkClass}>{d.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sortedCountries.length > 0 && (
        <section className="mt-16">
          <h2 className={sectionTitle}>
            Countries <span className="text-base font-normal text-forest-900/60">({sortedCountries.length})</span>
          </h2>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {sortedCountries.map((c) => (
              <li key={c.id}>
                <Link href={`/countries/${c.code.toLowerCase()}`} className={linkClass}>{c.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sortedAirlines.length > 0 && (
        <section className="mt-16">
          <h2 className={sectionTitle}>
            Airlines <span className="text-base font-normal text-forest-900/60">({sortedAirlines.length})</span>
          </h2>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {sortedAirlines.map((a) => (
              <li key={a.id}>
                <Link href={`/airlines/${a.slug}`} className={linkClass}>{a.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sortedAirports.length > 0 && (
        <section className="mt-16">
          <h2 className={sectionTitle}>
            Airports <span className="text-base font-normal text-forest-900/60">({sortedAirports.length})</span>
          </h2>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {sortedAirports.map((a) => (
              <li key={a.id}>
                <Link href={`/airports/${a.iata.toLowerCase()}`} className={linkClass}>
                  {a.iata.toUpperCase()} — {a.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
