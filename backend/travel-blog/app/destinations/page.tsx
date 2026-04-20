import Link from 'next/link';
import { listDestinations, mediaUrl } from '@/lib/strapi';

export const revalidate = 60;

export const metadata = {
  title: 'Destinations',
  description: 'Every place we\'ve written about — countries, regions, and cities worth your time.',
};

export default async function DestinationsPage() {
  const destinations = await listDestinations();

  const grouped = destinations.reduce<Record<string, typeof destinations>>((acc, d) => {
    const k = d.type || 'other';
    (acc[k] = acc[k] || []).push(d);
    return acc;
  }, {});

  const order: Array<keyof typeof grouped> = ['country', 'region', 'city', 'other'];

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="destinations-page">
      <header className="max-w-3xl">
        <p className="chip">Places</p>
        <h1 className="editorial-h mt-5 text-5xl font-black text-forest-900 lg:text-6xl">Where we've been</h1>
        <p className="mt-5 text-xl text-ink/70">
          {destinations.length} destinations and counting. Click any to see every story about it.
        </p>
      </header>

      {order.map((k) => {
        const items = grouped[k as string];
        if (!items?.length) return null;
        return (
          <section key={k as string} className="mt-16">
            <h2 className="editorial-h text-2xl font-bold capitalize text-forest-900">{String(k)}s</h2>
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {items.map((d) => {
                const img = mediaUrl(d.heroImage ?? null);
                return (
                  <Link
                    key={d.id}
                    href={`/destinations/${d.slug}`}
                    className="group relative aspect-[3/4] overflow-hidden rounded-2xl bg-forest-800"
                    data-testid={`destination-${d.slug}`}
                  >
                    {img && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img} alt={d.name} className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-110" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-forest-950/90 via-forest-950/30 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-5 text-sand-100">
                      <div className="editorial-h text-2xl font-bold">{d.name}</div>
                      {d.countryCode && <div className="text-xs uppercase tracking-widest opacity-70">{d.countryCode}</div>}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
