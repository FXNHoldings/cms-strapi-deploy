import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAirline, listRoutesByCarrier, mediaUrl, type StrapiAirline } from '@/lib/strapi';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const a = await getAirline(slug);
  if (!a) return { title: 'Not found' };
  const desc = a.about?.slice(0, 150) || `${a.name}${a.iataCode ? ` (${a.iataCode})` : ''} — airline profile, base of operations, and contact details.`;
  return { title: a.name, description: desc };
}

export default async function AirlinePage({ params }: Props) {
  const { slug } = await params;
  const airline = await getAirline(slug);
  if (!airline) notFound();

  const routes = await listRoutesByCarrier(slug, 15).catch(() => []);
  const logo = mediaUrl(airline.logo ?? null);

  return (
    <article data-testid={`airline-page-${slug}`}>
      {/* Breadcrumb */}
      <div className="mx-auto max-w-6xl px-6 pt-10">
        <nav className="text-xs uppercase tracking-widest text-forest-900/60">
          <Link href="/airlines" className="hover:text-forest-900">Airlines</Link>
          <span className="mx-2 text-forest-900/30">/</span>
          <span className="text-forest-900/80">{airline.name}</span>
        </nav>
      </div>

      {/* Hero */}
      <header className="mx-auto mt-6 max-w-6xl px-6">
        <div className="flex flex-col gap-6 border-b border-forest-900/10 pb-10 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex h-24 w-24 flex-none items-center justify-center overflow-hidden rounded-[0.3rem] border border-forest-900/10 bg-forest-900/5">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={airline.name} className="h-full w-full object-contain p-2" />
            ) : (
              <span className="font-urbanist text-2xl font-bold text-forest-900/60">
                {(airline.iataCode || airline.name).slice(0, 3).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-widest text-forest-900/60">
              {airline.type && <span className="chip">{airline.type}</span>}
              {airline.region && <span>{airline.region}</span>}
              {airline.country && <span>· {airline.country}</span>}
            </div>
            <h1 className="editorial-h mt-3 text-3xl font-bold leading-tight text-forest-900 sm:text-4xl">
              {airline.name}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-xs">
              {airline.iataCode && (
                <span className="rounded-[0.3rem] bg-forest-900 px-3 py-1.5 font-bold tracking-wider text-sand-100">
                  IATA · {airline.iataCode}
                </span>
              )}
              {airline.icaoCode && (
                <span className="rounded-[0.3rem] border border-forest-900/20 px-3 py-1.5 font-bold tracking-wider text-forest-900">
                  ICAO · {airline.icaoCode}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* About + Details — two columns: details (30%) on the left, about (60%) offset to the right */}
      <section className="mx-auto mt-14 max-w-6xl px-6 pb-20" data-testid="airline-about">
        <div className="grid gap-10 lg:grid-cols-[3fr_6fr]">
          <aside className="rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 lg:self-start">
            <h3 className="editorial-h text-xs font-bold uppercase tracking-wider text-forest-900/60">
              Details
            </h3>
            <dl className="mt-5 space-y-4">
              <InfoRow label="IATA Code" value={airline.iataCode} mono />
              <InfoRow label="ICAO Code" value={airline.icaoCode} mono />
              <InfoRow label="Legal Name" value={airline.legalName} />
              <InfoRow label="Country" value={airline.country} />
              <InfoRow label="Region" value={airline.region} />
              <InfoRow label="Address" value={airline.address} multiline />
              <InfoRow label="Phone" value={airline.phone} />
              <InfoRow
                label="Website"
                value={
                  airline.website ? (
                    <a
                      href={airline.website.startsWith('http') ? airline.website : `https://${airline.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-forest-700 underline-offset-2 hover:underline"
                    >
                      {airline.website.replace(/^https?:\/\//, '')}
                    </a>
                  ) : undefined
                }
              />
            </dl>
          </aside>

          <div className="lg:pl-6">
            <p className="section-eyebrow">
              <span className="inline-block h-px w-8 bg-forest-800/60" />
              About {airline.name}
            </p>
            {airline.about ? (
              <div className="prose-article mt-4">
                {airline.about.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-forest-900/50">No profile written for {airline.name} yet.</p>
            )}
          </div>
        </div>
      </section>

      {/* Popular routes operated by this airline */}
      {routes.length > 0 && (
        <section className="mx-auto max-w-6xl px-6 pb-20" data-testid="airline-routes">
          <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
            <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
              Popular routes operated by {airline.name}
            </h2>
            <span className="text-sm font-light text-forest-900/50">
              {routes.length} route{routes.length === 1 ? '' : 's'}
            </span>
          </header>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {routes.map((r) => (
              <Link
                key={r.id}
                href={`/flights/${r.slug}`}
                className="group flex items-center justify-between rounded-[0.3rem] border border-forest-900/10 bg-paper p-5 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
                data-testid={`airline-route-${r.slug}`}
              >
                <div>
                  <div className="font-mono text-xs font-bold tracking-wider text-forest-900/70">
                    {r.origin?.iata} → {r.destination?.iata}
                  </div>
                  <div className="mt-2 font-urbanist text-base font-bold text-forest-900 group-hover:text-forest-700">
                    {r.origin?.city || r.origin?.name} → {r.destination?.city || r.destination?.name}
                  </div>
                  <div className="mt-1 text-xs text-forest-900/60">
                    {r.origin?.country && r.destination?.country
                      ? `${r.origin.country} · ${r.destination.country}`
                      : r.origin?.country || r.destination?.country || ''}
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
        </section>
      )}
    </article>
  );
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function InfoRow({
  label,
  value,
  mono = false,
  multiline = false,
}: {
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-widest text-forest-900/50">{label}</dt>
      <dd
        className={
          'mt-1 text-sm text-forest-900 ' +
          (mono ? 'font-mono font-bold tracking-wider ' : 'font-light ') +
          (multiline ? 'whitespace-pre-wrap ' : '')
        }
      >
        {value ?? <span className="text-forest-900/30">—</span>}
      </dd>
    </div>
  );
}
