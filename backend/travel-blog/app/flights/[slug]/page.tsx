import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getRoute, mediaUrl, type StrapiAirline } from '@/lib/strapi';
import { flightSearchUrl } from '@/lib/affiliate';
import PriceCalendar from '@/components/PriceCalendar';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await getRoute(slug);
  if (!r || !r.origin || !r.destination) return { title: 'Route not found' };
  const title = `Flights from ${r.origin.city || r.origin.name} to ${r.destination.city || r.destination.name} (${r.origin.iata} → ${r.destination.iata})`;
  const desc =
    r.about?.slice(0, 150) ||
    `Cheap flights from ${r.origin.iata} to ${r.destination.iata}. Carriers, flight time, distance, and where to book.`;
  return { title, description: desc };
}

export default async function RoutePage({ params }: Props) {
  const { slug } = await params;
  const route = await getRoute(slug);
  if (!route || !route.origin || !route.destination) notFound();

  const { origin, destination } = route;
  const carriers = route.carriers ?? [];

  // TravelPayouts white-label deep link with dates (depart +30d, return +37d, 1 pax).
  const searchUrl = flightSearchUrl({
    origin: origin.iata,
    destination: destination.iata,
    subId: `route:${slug}`,
  });

  return (
    <article data-testid={`route-page-${slug}`}>
      {/* Breadcrumb */}
      <div className="mx-auto max-w-6xl px-6 pt-10">
        <nav className="text-xs uppercase tracking-widest text-forest-900/60">
          <span>Flights</span>
          <span className="mx-2 text-forest-900/30">/</span>
          <Link href={`/airports/${origin.iata.toLowerCase()}`} className="hover:text-forest-900">
            {origin.iata}
          </Link>
          <span className="mx-2 text-forest-900/30">→</span>
          <Link href={`/airports/${destination.iata.toLowerCase()}`} className="hover:text-forest-900">
            {destination.iata}
          </Link>
        </nav>
      </div>

      {/* Hero — origin → destination */}
      <header className="mx-auto mt-8 max-w-6xl px-6">
        <p className="font-urbanist text-xs uppercase tracking-wider text-forest-800/70">
          Route · {origin.iata} → {destination.iata}
        </p>
        <h1 className="editorial-h mt-4 text-3xl font-bold leading-tight text-forest-900 sm:text-4xl">
          Flights from {origin.city || origin.name} to {destination.city || destination.name}
        </h1>
        <div className="mt-6 grid gap-4 sm:grid-cols-[1fr,auto,1fr] sm:items-center">
          <AirportCard airport={origin} align="left" />
          <div className="flex flex-col items-center justify-center gap-2 text-forest-900/60">
            <svg width="40" height="24" viewBox="0 0 40 24" fill="none" className="text-forest-600 sm:w-16" aria-hidden>
              <path d="M2 12 L38 12 M30 4 L38 12 L30 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {route.distanceKm && (
              <span className="font-mono text-xs font-bold tracking-wider text-forest-900/70">
                {route.distanceKm.toLocaleString()} km
              </span>
            )}
          </div>
          <AirportCard airport={destination} align="right" />
        </div>

        {/* Primary CTA — white-label deep link */}
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <a
            href={searchUrl}
            target="_blank"
            rel="sponsored nofollow noopener"
            className="inline-flex items-center gap-2 rounded-[0.3rem] bg-forest-900 px-6 py-3 font-urbanist text-sm font-bold uppercase tracking-wider text-sand-100 transition hover:bg-forest-800"
            data-testid="route-search-cta"
          >
            Find flights {origin.iata} → {destination.iata} →
          </a>
          <p className="text-xs text-forest-900/50">
            We may earn a commission when you book — at no cost to you.
          </p>
        </div>
      </header>

      {/* Quick facts strip */}
      <section className="mx-auto mt-12 max-w-6xl px-6">
        <div className="grid gap-6 rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 sm:grid-cols-4">
          <Stat label="Distance" value={route.distanceKm ? `${route.distanceKm.toLocaleString()} km` : '—'} />
          <Stat label="Flight time" value={route.durationMinutes ? formatDuration(route.durationMinutes) : '—'} />
          <Stat label="Carriers tracked" value={carriers.length.toString()} />
          <Stat label="Route" value={`${origin.iata} → ${destination.iata}`} mono />
        </div>
      </section>

      {/* Live price calendar — TravelPayouts widget */}
      <section className="mx-auto mt-14 max-w-6xl px-6" data-testid="route-price-calendar">
        <header className="mb-5 flex items-baseline justify-between">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
            Cheapest dates to fly
          </h2>
          <span className="text-xs font-light text-forest-900/50">
            Live prices · powered by Aviasales
          </span>
        </header>
        <div className="rounded-[0.3rem] border border-forest-900/10 bg-paper p-2">
          <PriceCalendar origin={origin.iata} destination={destination.iata} />
        </div>
      </section>

      {/* About */}
      {route.about && (
        <section className="mx-auto mt-14 max-w-3xl px-6">
          <p className="section-eyebrow">
            <span className="inline-block h-px w-8 bg-forest-800/60" />
            About this route
          </p>
          <div className="prose-article mt-4">
            {route.about.split(/\n{2,}/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </section>
      )}

      {/* Carriers */}
      {carriers.length > 0 && (
        <section className="mx-auto mt-16 max-w-6xl px-6">
          <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
            <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
              Airlines on this route
            </h2>
            <span className="text-sm font-light text-forest-900/50">
              {carriers.length} carrier{carriers.length === 1 ? '' : 's'}
            </span>
          </header>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {carriers.map((c) => (
              <CarrierCard key={c.id} carrier={c} route={slug} origin={origin.iata} destination={destination.iata} />
            ))}
          </div>
        </section>
      )}

      {/* Airport cross-links */}
      <section className="mx-auto mt-16 max-w-6xl px-6 pb-20">
        <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">Airport guides</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <AirportLink airport={origin} />
          <AirportLink airport={destination} />
        </div>
      </section>
    </article>
  );
}

function AirportCard({
  airport,
  align,
}: {
  airport: { iata: string; name: string; city?: string; country?: string };
  align: 'left' | 'right';
}) {
  return (
    <div className={'rounded-[0.3rem] border border-forest-900/10 bg-paper p-5 ' + (align === 'right' ? 'sm:text-right' : '')}>
      <div className="font-mono text-xs font-bold tracking-wider text-forest-900/60">{airport.iata}</div>
      <div className="mt-1 font-urbanist text-xl font-bold text-forest-900">{airport.city || airport.name}</div>
      <div className="mt-1 text-sm text-forest-900/60">
        {airport.name}
        {airport.country && <span className="block text-xs text-forest-900/50">{airport.country}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className={'font-urbanist text-2xl font-bold text-forest-900 lg:text-3xl ' + (mono ? 'font-mono !text-xl lg:!text-2xl' : '')}>
        {value}
      </div>
      <div className="mt-1 text-xs uppercase tracking-widest text-forest-900/60">{label}</div>
    </div>
  );
}

function CarrierCard({
  carrier,
  origin,
  destination,
  route,
}: {
  carrier: StrapiAirline;
  origin: string;
  destination: string;
  route: string;
}) {
  const logo = mediaUrl(carrier.logo ?? null);
  const carrierSearchUrl = flightSearchUrl({
    origin,
    destination,
    subId: `route:${route}:${carrier.iataCode || carrier.slug}`,
    airline: carrier.iataCode,
  });
  return (
    <div className="rounded-[0.3rem] border border-forest-900/10 bg-paper p-5">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 flex-none items-center justify-center overflow-hidden rounded-[0.3rem] bg-forest-900/5">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={carrier.name} className="h-full w-full object-contain" />
          ) : (
            <span className="font-urbanist text-xs font-bold text-forest-900/60">
              {(carrier.iataCode || carrier.name).slice(0, 3).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <Link
            href={`/airlines/${carrier.slug}`}
            className="block font-urbanist text-base font-bold text-forest-900 hover:text-forest-700"
          >
            {carrier.name}
          </Link>
          {carrier.iataCode && (
            <span className="mt-1 inline-block rounded-[0.3rem] bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
              {carrier.iataCode}
            </span>
          )}
        </div>
      </div>
      <a
        href={carrierSearchUrl}
        target="_blank"
        rel="sponsored nofollow noopener"
        className="mt-4 inline-flex w-full items-center justify-center rounded-[0.3rem] border border-forest-900/20 px-4 py-2 text-xs font-medium uppercase tracking-wider text-forest-900 transition hover:bg-forest-900 hover:text-sand-100"
      >
        Book with {carrier.name} →
      </a>
    </div>
  );
}

function AirportLink({ airport }: { airport: { iata: string; name: string; city?: string } }) {
  return (
    <Link
      href={`/airports/${airport.iata.toLowerCase()}`}
      className="group flex items-center justify-between rounded-[0.3rem] border border-forest-900/10 bg-paper p-5 transition hover:border-forest-900/30"
    >
      <div>
        <div className="font-mono text-xs font-bold tracking-wider text-forest-900/60">{airport.iata}</div>
        <div className="mt-1 font-urbanist text-base font-bold text-forest-900 group-hover:text-forest-700">
          {airport.city || airport.name}
        </div>
        <div className="mt-1 text-xs text-forest-900/50">Airport guide</div>
      </div>
      <span className="font-urbanist text-2xl text-forest-900/40 transition group-hover:translate-x-1 group-hover:text-forest-600">→</span>
    </Link>
  );
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
