import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  getDestination,
  listAirlinesByCountry,
  listAirportsByCountryCode,
  listArticles,
  listRoutesToDestination,
  mediaUrl,
  type StrapiAirline,
  type StrapiAirport,
  type StrapiDestination,
} from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
import CountryDetailSections from '@/components/CountryDetailSections';
import HotelSearchCTA from '@/components/HotelSearchCTA';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const d = await getDestination(slug);
  if (!d) return { title: 'Not found' };
  return { title: d.name, description: d.description };
}

export default async function DestinationPage({ params }: Props) {
  const { slug } = await params;
  const destination = await getDestination(slug);
  if (!destination) notFound();

  const isCountry = destination.type === 'country' && !!destination.countryCode;
  const routeLimit = isCountry ? 4 : 12;

  const [{ data: articles }, routes, airports, airlines] = await Promise.all([
    listArticles({ destination: slug, pageSize: 24 }),
    listRoutesToDestination(destination, routeLimit).catch(() => []),
    isCountry
      ? listAirportsByCountryCode(destination.countryCode as string).catch(() => [] as StrapiAirport[])
      : Promise.resolve<StrapiAirport[]>([]),
    isCountry
      ? listAirlinesByCountry(destination.name).catch(() => [] as StrapiAirline[])
      : Promise.resolve<StrapiAirline[]>([]),
  ]);

  const hero = mediaUrl(destination.heroImage ?? null);

  if (isCountry) {
    return (
      <CountryDestinationPage
        destination={destination}
        hero={hero}
        airports={airports}
        airlines={airlines}
        routes={routes}
        articles={articles}
      />
    );
  }

  // Non-country destinations (city / region) keep the original layout unchanged.
  return (
    <div data-testid={`destination-page-${slug}`}>
      <section className="relative h-[55vh] min-h-[380px] overflow-hidden bg-forest-900">
        {hero && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={hero} alt={destination.name} className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-forest-950/90 via-forest-950/30 to-forest-950/10" />
        <div className="relative mx-auto flex h-full max-w-7xl flex-col justify-end px-6 pb-14 text-sand-100">
          <div className="text-xs uppercase tracking-widest opacity-80">
            {destination.type ?? 'Destination'}{destination.countryCode ? ` · ${destination.countryCode}` : ''}
          </div>
          <h1 className="editorial-h mt-3 text-3xl font-bold sm:text-4xl">{destination.name}</h1>
          {destination.description && (
            <p className="mt-4 max-w-2xl text-lg opacity-90">{destination.description}</p>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-6 py-16">
        <h2 className="editorial-h text-3xl font-bold text-forest-900">
          {articles.length === 0 ? 'No stories yet' : `${articles.length} stor${articles.length === 1 ? 'y' : 'ies'} from ${destination.name}`}
        </h2>
        {articles.length > 0 && (
          <div className="mt-10 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
            {articles.map((a) => <ArticleCard key={a.id} article={a} size="md" />)}
          </div>
        )}
      </div>

      {routes.length > 0 && (
        <section className="mx-auto max-w-7xl px-6" data-testid="destination-routes">
          <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
            <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-2xl">
              Flights to {destination.name}
            </h2>
            <span className="text-sm font-light text-forest-900/50">
              {routes.length} route{routes.length === 1 ? '' : 's'}
            </span>
          </header>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {routes.map((r) => <RouteCard key={r.id} r={r} />)}
          </div>
          <div className="mt-6">
            <Link href="/flights" className="text-sm font-medium text-forest-700 hover:underline">
              Browse all routes →
            </Link>
          </div>
        </section>
      )}

      <div className="pb-20">
        <HotelSearchCTA destination={destination.name} subId={`destination-${slug}`} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Country-type destination page                                              */
/* -------------------------------------------------------------------------- */

function CountryDestinationPage({
  destination,
  hero,
  airports,
  airlines,
  routes,
  articles,
}: {
  destination: StrapiDestination;
  hero: string | null;
  airports: StrapiAirport[];
  airlines: StrapiAirline[];
  routes: Awaited<ReturnType<typeof listRoutesToDestination>>;
  articles: Awaited<ReturnType<typeof listArticles>>['data'];
}) {
  const cityCount = new Set(airports.map((a) => a.city).filter(Boolean)).size;

  return (
    <article data-testid={`destination-page-${destination.slug}`}>
      {/* 1. Hero — original layout (bottom-anchored, left-aligned) with light image + dark text, stats on the right */}
      <section className="relative h-[55vh] min-h-[380px] overflow-hidden bg-paper">
        {hero && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hero}
            alt={destination.name}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-25"
          />
        )}
        {/* Paper wash — heavier at the bottom so dark text stays crisp */}
        <div className="absolute inset-0 bg-gradient-to-t from-paper/85 via-paper/20 to-transparent" />

        <div className="relative mx-auto flex h-full max-w-7xl flex-col justify-end px-6 pb-14">
          <div className="grid items-end gap-8 sm:grid-cols-[1fr_auto]">
            {/* Left — text column */}
            <div>
              <div className="text-xs uppercase tracking-widest text-forest-900/60">
                {destination.type ?? 'Destination'}
                {destination.countryCode ? ` · ${destination.countryCode}` : ''}
              </div>
              <h1 className="editorial-h mt-3 text-3xl font-bold text-forest-900 sm:text-4xl">
                {destination.name}
              </h1>
              {destination.description && (
                <p className="mt-4 max-w-2xl text-lg leading-relaxed text-forest-900/75">
                  {destination.description}
                </p>
              )}
            </div>

            {/* Right — stats column */}
            <div className="grid grid-cols-2 gap-x-10 gap-y-5 sm:min-w-[260px]">
              <HeroStat label="Airports" value={airports.length} />
              <HeroStat label="Cities" value={cityCount} />
              <HeroStat label="Airlines" value={airlines.length} />
              <HeroStat label="Stories" value={articles.length} />
            </div>
          </div>
        </div>
      </section>

      {/* 2 + 3. Airports and Airlines */}
      <CountryDetailSections
        countryName={destination.name}
        airports={airports}
        airlines={airlines}
      />

      {/* 4. Flights — 4 cards */}
      {routes.length > 0 && (
        <section className="mx-auto mt-16 max-w-7xl px-6" data-testid="destination-routes">
          <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
            <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-2xl">
              Flights to {destination.name}
            </h2>
            <span className="text-sm font-light text-forest-900/50">
              {routes.length} route{routes.length === 1 ? '' : 's'}
            </span>
          </header>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {routes.slice(0, 4).map((r) => <RouteCard key={r.id} r={r} />)}
          </div>
          <div className="mt-6">
            <Link href="/flights" className="text-sm font-medium text-forest-700 hover:underline">
              Browse all routes →
            </Link>
          </div>
        </section>
      )}

      {/* 4b. Hotels CTA */}
      <HotelSearchCTA destination={destination.name} subId={`destination-${destination.slug}`} />

      {/* 5. Stories — 4 cards */}
      <section className="mx-auto mt-16 max-w-7xl px-6 pb-20" data-testid="destination-stories">
        <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-2xl">
            {articles.length === 0
              ? `No stories from ${destination.name} yet`
              : `${articles.length} stor${articles.length === 1 ? 'y' : 'ies'} from ${destination.name}`}
          </h2>
          {articles.length > 4 && (
            <span className="text-sm font-light text-forest-900/50">
              showing 4 of {articles.length}
            </span>
          )}
        </header>
        {articles.length > 0 && (
          <div className="mt-10 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {articles.slice(0, 4).map((a) => <ArticleCard key={a.id} article={a} size="compact" />)}
          </div>
        )}
      </section>
    </article>
  );
}

function HeroStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-urbanist text-3xl font-bold leading-none text-forest-900">
        {value.toLocaleString()}
      </div>
      <div className="mt-2 text-xs uppercase tracking-widest text-forest-900/60">{label}</div>
    </div>
  );
}

function RouteCard({ r }: { r: Awaited<ReturnType<typeof listRoutesToDestination>>[number] }) {
  return (
    <Link
      href={`/flights/${r.slug}`}
      className="group flex items-center justify-between rounded-lg border border-forest-900/10 bg-paper p-5 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
      data-testid={`destination-route-${r.slug}`}
    >
      <div>
        <div className="font-mono text-xs font-bold tracking-wider text-forest-900/70">
          {r.origin?.iata} → {r.destination?.iata}
        </div>
        <div className="mt-2 font-urbanist text-base font-bold text-forest-900 group-hover:text-forest-700">
          From {r.origin?.city || r.origin?.name}
        </div>
        <div className="mt-1 text-xs text-forest-900/60">{r.origin?.country}</div>
      </div>
      {r.distanceKm && (
        <div className="text-right text-xs text-forest-900/50">
          <div className="font-mono font-bold text-forest-900/70">
            {r.distanceKm.toLocaleString()} km
          </div>
          {r.durationMinutes && (
            <div className="mt-1">{formatDuration(r.durationMinutes)}</div>
          )}
        </div>
      )}
    </Link>
  );
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
