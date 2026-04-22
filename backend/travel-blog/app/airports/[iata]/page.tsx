import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAirport, listRoutesFromAirport, mediaUrl } from '@/lib/strapi';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ iata: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { iata } = await params;
  const a = await getAirport(iata);
  if (!a) return { title: 'Airport not found' };
  return {
    title: `${a.name} (${a.iata}) — airport guide`,
    description:
      a.about?.slice(0, 150) ||
      `${a.name} (${a.iata}) airport guide: terminals, airlines, top destinations, and ground transfer options.`,
  };
}

export default async function AirportPage({ params }: Props) {
  const { iata } = await params;
  const airport = await getAirport(iata);
  if (!airport) notFound();

  const routes = await listRoutesFromAirport(airport.iata, 12);
  const hero = mediaUrl(airport.heroImage ?? null);

  return (
    <article data-testid={`airport-page-${airport.iata}`}>
      {/* Breadcrumb */}
      <div className="mx-auto max-w-6xl px-6 pt-10">
        <nav className="text-xs uppercase tracking-widest text-forest-900/60">
          <Link href="/airlines" className="hover:text-forest-900">Airlines</Link>
          <span className="mx-2 text-forest-900/30">/</span>
          <span>Airports</span>
          <span className="mx-2 text-forest-900/30">/</span>
          <span className="text-forest-900/80">{airport.iata}</span>
        </nav>
      </div>

      {/* Hero */}
      <header className="relative mx-auto mt-6 max-w-6xl overflow-hidden rounded-[0.3rem]">
        {hero ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={hero} alt={airport.name} className="h-[320px] w-full object-cover" />
        ) : (
          <div className="h-[240px] w-full bg-gradient-to-br from-forest-900 to-forest-700" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-forest-950/85 via-forest-950/30 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-8 pb-8 text-sand-100">
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-widest opacity-80">
            <span>{airport.region}</span>
            {airport.country && <span>· {airport.country}</span>}
            {airport.timezone && <span>· {airport.timezone}</span>}
          </div>
          <h1 className="editorial-h mt-3 text-4xl font-black leading-[1.05] lg:text-6xl">
            {airport.name}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-xs">
            <span className="rounded-[0.3rem] bg-forest-950/80 px-3 py-1.5 font-bold tracking-wider">
              IATA · {airport.iata}
            </span>
            {airport.icao && (
              <span className="rounded-[0.3rem] border border-sand-100/30 px-3 py-1.5 font-bold tracking-wider">
                ICAO · {airport.icao}
              </span>
            )}
            {airport.city && <span className="opacity-80">Serving {airport.city}</span>}
          </div>
        </div>
      </header>

      {/* About */}
      {airport.about && (
        <section className="mx-auto mt-14 max-w-3xl px-6">
          <p className="section-eyebrow">
            <span className="inline-block h-px w-8 bg-forest-800/60" />
            About {airport.iata}
          </p>
          <div className="prose-article mt-4">
            {airport.about.split(/\n{2,}/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </section>
      )}

      {/* Top routes from here */}
      <section className="mx-auto mt-16 max-w-6xl px-6 pb-20">
        <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
            Top routes from {airport.iata}
          </h2>
          <span className="text-sm font-light text-forest-900/50">
            {routes.length} route{routes.length === 1 ? '' : 's'}
          </span>
        </header>
        {routes.length === 0 ? (
          <p className="mt-10 text-forest-900/60">
            No routes tracked from {airport.iata} yet.
          </p>
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
                  <div className="mt-2 font-urbanist text-base font-bold text-forest-900 group-hover:text-terracotta-700">
                    {r.destination?.city || r.destination?.name}
                  </div>
                  <div className="mt-1 text-xs text-forest-900/60">
                    {r.destination?.country}
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

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
