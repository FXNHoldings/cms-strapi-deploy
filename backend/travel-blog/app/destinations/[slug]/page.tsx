import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getDestination, listArticles, listRoutesToDestination, mediaUrl } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
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

  const [{ data: articles }, routes] = await Promise.all([
    listArticles({ destination: slug, pageSize: 24 }),
    listRoutesToDestination(destination, 12).catch(() => []),
  ]);
  const hero = mediaUrl(destination.heroImage ?? null);

  return (
    <div data-testid={`destination-page-${slug}`}>
      {/* Hero */}
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
          <h1 className="editorial-h mt-3 text-6xl font-black lg:text-8xl">{destination.name}</h1>
          {destination.description && (
            <p className="mt-4 max-w-2xl text-lg opacity-90">{destination.description}</p>
          )}
        </div>
      </section>

      {/* Articles */}
      <div className="mx-auto max-w-7xl px-6 py-16">
        <h2 className="editorial-h text-3xl font-black text-forest-900">
          {articles.length === 0 ? 'No stories yet' : `${articles.length} stor${articles.length === 1 ? 'y' : 'ies'} from ${destination.name}`}
        </h2>
        {articles.length > 0 && (
          <div className="mt-10 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
            {articles.map((a) => <ArticleCard key={a.id} article={a} size="md" />)}
          </div>
        )}
      </div>

      {/* Flights to this destination */}
      {routes.length > 0 && (
        <section className="mx-auto max-w-7xl px-6 pb-20" data-testid="destination-routes">
          <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
            <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">
              Flights to {destination.name}
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
                data-testid={`destination-route-${r.slug}`}
              >
                <div>
                  <div className="font-mono text-xs font-bold tracking-wider text-forest-900/70">
                    {r.origin?.iata} → {r.destination?.iata}
                  </div>
                  <div className="mt-2 font-urbanist text-base font-bold text-forest-900 group-hover:text-forest-700">
                    From {r.origin?.city || r.origin?.name}
                  </div>
                  <div className="mt-1 text-xs text-forest-900/60">
                    {r.origin?.country}
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
          <div className="mt-6">
            <Link
              href="/flights"
              className="text-sm font-medium text-forest-700 hover:underline"
            >
              Browse all routes →
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
