import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  getCountry,
  listAirports,
  listAirportsByCountryCode,
  listAirlinesByCountry,
  listRoutesByCountryCode,
  mediaUrl,
  type StrapiAirport,
} from '@/lib/strapi';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ code: string }> };

function flagEmoji(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const cc = code.toUpperCase();
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

async function resolveCountry(code: string): Promise<{
  code: string;
  name: string;
  region?: string;
  currency?: string;
  about?: string;
} | null> {
  const cc = code.toUpperCase();
  const fromCollection = await getCountry(cc).catch(() => null);
  if (fromCollection) {
    return {
      code: cc,
      name: fromCollection.name,
      region: fromCollection.region,
      currency: fromCollection.currency,
      about: fromCollection.about,
    };
  }
  const airports = await listAirportsByCountryCode(cc, 1).catch(() => []);
  if (airports.length === 0) return null;
  const a = airports[0];
  return { code: cc, name: a.country || cc, region: a.region };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const country = await resolveCountry(code);
  if (!country) return { title: 'Country not found' };
  return {
    title: `${country.name} — airports, airlines & top routes`,
    description: `Travel directory for ${country.name} (${country.code}): commercial airports, airlines based in the country, and the busiest inbound routes.`,
  };
}

export default async function CountryPage({ params }: Props) {
  const { code } = await params;
  const country = await resolveCountry(code);
  if (!country) notFound();

  const [airports, airlines, routes] = await Promise.all([
    listAirportsByCountryCode(country.code).catch(() => []),
    listAirlinesByCountry(country.name).catch(() => []),
    listRoutesByCountryCode(country.code, 12).catch(() => []),
  ]);

  const cityCount = new Set(airports.map((a) => a.city).filter(Boolean)).size;

  return (
    <article data-testid={`country-page-${country.code}`}>
      {/* Breadcrumb */}
      <div className="mx-auto max-w-6xl px-6 pt-10">
        <nav className="text-xs uppercase tracking-widest text-forest-900/60">
          <Link href="/countries" className="hover:text-forest-900">Countries</Link>
          <span className="mx-2 text-forest-900/30">/</span>
          <span className="text-forest-900/80">{country.code}</span>
        </nav>
      </div>

      {/* Hero */}
      <header className="mx-auto mt-6 max-w-6xl overflow-hidden rounded-[0.3rem] bg-gradient-to-br from-forest-900 to-forest-700 px-8 py-14 text-sand-100">
        <div className="flex items-center gap-4">
          <span className="text-6xl leading-none" aria-hidden>{flagEmoji(country.code)}</span>
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-widest opacity-80">
              {country.region && <span>{country.region}</span>}
              <span className="rounded-[0.3rem] bg-forest-950/60 px-2 py-0.5 font-mono font-bold tracking-wider">
                ISO · {country.code}
              </span>
              {country.currency && (
                <span className="rounded-[0.3rem] bg-forest-950/60 px-2 py-0.5 font-mono font-bold tracking-wider">
                  {country.currency}
                </span>
              )}
            </div>
            <h1 className="editorial-h mt-3 text-4xl font-black leading-[1.05] lg:text-6xl">
              {country.name}
            </h1>
            {country.about && (
              <p className="mt-3 max-w-2xl text-sm font-light leading-relaxed opacity-85">
                {country.about}
              </p>
            )}
          </div>
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <Stat label="Airports" value={airports.length.toLocaleString()} />
          <Stat label="Cities served" value={cityCount.toLocaleString()} />
          <Stat label="Airlines" value={airlines.length.toLocaleString()} />
        </div>
      </header>

      {/* Airports */}
      <section className="mx-auto mt-16 max-w-6xl px-6">
        <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
            Airports in {country.name}
          </h2>
          <span className="text-sm font-light text-forest-900/50">
            {airports.length} airport{airports.length === 1 ? '' : 's'}
          </span>
        </header>
        {airports.length === 0 ? (
          <p className="mt-10 text-forest-900/60">No airports indexed for {country.name} yet.</p>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {airports.slice(0, 60).map((a) => <AirportCard key={a.id} airport={a} />)}
          </div>
        )}
        {airports.length > 60 && (
          <p className="mt-4 text-xs text-forest-900/50">
            + {airports.length - 60} more — see the full <Link href="/airports" className="underline hover:text-forest-900">airports directory</Link>.
          </p>
        )}
      </section>

      {/* Airlines */}
      <section className="mx-auto mt-16 max-w-6xl px-6">
        <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
            Airlines based in {country.name}
          </h2>
          <span className="text-sm font-light text-forest-900/50">
            {airlines.length} airline{airlines.length === 1 ? '' : 's'}
          </span>
        </header>
        {airlines.length === 0 ? (
          <p className="mt-10 text-forest-900/60">No airlines tagged to {country.name} yet.</p>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {airlines.slice(0, 30).map((al) => {
              const logo = mediaUrl(al.logo ?? null);
              return (
                <Link
                  key={al.id}
                  href={`/airlines/${al.slug}`}
                  className="group flex items-center gap-4 rounded-[0.3rem] border border-forest-900/10 bg-paper p-4 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
                >
                  <div className="flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-[0.3rem] bg-forest-900/5">
                    {logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logo} alt={al.name} className="h-full w-full object-contain" />
                    ) : (
                      <span className="font-urbanist text-sm font-bold text-forest-900/60">
                        {(al.iataCode || al.name).slice(0, 3).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate font-urbanist text-base font-bold text-forest-900 group-hover:text-forest-700">
                        {al.name}
                      </div>
                      {al.iataCode && (
                        <span className="flex-none rounded-[0.3rem] bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
                          {al.iataCode}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-xs text-forest-900/60">
                      {[al.city, al.type].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Top inbound routes */}
      <section className="mx-auto mt-16 max-w-6xl px-6 pb-20">
        <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
            Popular routes to {country.name}
          </h2>
          <span className="text-sm font-light text-forest-900/50">
            {routes.length} route{routes.length === 1 ? '' : 's'}
          </span>
        </header>
        {routes.length === 0 ? (
          <p className="mt-10 text-forest-900/60">No routes tracked inbound to {country.name} yet.</p>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {routes.map((r) => (
              <Link
                key={r.id}
                href={`/flights/${r.slug}`}
                className="group flex items-center justify-between rounded-[0.3rem] border border-forest-900/10 bg-paper p-5 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
              >
                <div>
                  <div className="font-mono text-xs font-bold tracking-wider text-forest-900/70">
                    {r.origin?.iata} → {r.destination?.iata}
                  </div>
                  <div className="mt-2 font-urbanist text-base font-bold text-forest-900 group-hover:text-forest-700">
                    {r.destination?.city || r.destination?.name}
                  </div>
                  <div className="mt-1 text-xs text-forest-900/60">
                    from {r.origin?.city || r.origin?.country}
                  </div>
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
            ))}
          </div>
        )}
      </section>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-urbanist text-3xl font-black leading-none lg:text-4xl">{value}</div>
      <div className="mt-2 text-xs uppercase tracking-widest opacity-70">{label}</div>
    </div>
  );
}

function AirportCard({ airport }: { airport: StrapiAirport }) {
  return (
    <Link
      href={`/airports/${airport.iata.toLowerCase()}`}
      className="group flex items-center justify-between gap-3 rounded-[0.3rem] border border-forest-900/10 bg-paper px-4 py-3 transition hover:-translate-y-0.5 hover:border-forest-900/30"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="flex-none rounded-[0.3rem] bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
            {airport.iata}
          </span>
          <div className="truncate font-urbanist text-sm font-bold text-forest-900 group-hover:text-forest-700">
            {airport.city || airport.name}
          </div>
        </div>
        <div className="mt-1 truncate text-xs text-forest-900/60">{airport.name}</div>
      </div>
    </Link>
  );
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export async function generateStaticParams() {
  const airports = await listAirports().catch(() => []);
  const codes = new Set<string>();
  for (const a of airports) {
    if (a.countryCode) codes.add(a.countryCode.toLowerCase());
  }
  return Array.from(codes).map((code) => ({ code }));
}
