import Link from 'next/link';
import type { Metadata } from 'next';
import { listDestinations, mediaUrl, type StrapiDestination } from '@/lib/strapi';
import { isStay22Configured, allezLink } from '@/lib/stay22';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Hotels',
  description:
    'Find hotels, vacation rentals and Airbnbs in every destination we cover — one search across Booking.com, Airbnb, VRBO, Hotels.com and Expedia.',
};

export default async function HotelsIndexPage() {
  const destinations = await listDestinations().catch(() => []);

  // Country + city pages get an entry. Regions are too broad for an Allora map.
  const indexable = destinations.filter(
    (d) => d.type === 'country' || d.type === 'city',
  );

  const countries = indexable.filter((d) => d.type === 'country');
  const cities = indexable.filter((d) => d.type === 'city');

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="hotels-index-page">
      <header className="max-w-3xl">
        <p className="chip">Where to stay</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">
          Hotels &amp; stays, in every destination we cover
        </h1>
        <p className="mt-5 text-xl text-ink/70">
          One search, every major booking site. Pick a destination to see hotels, Airbnbs and
          vacation rentals on a live map — book through Booking.com, Airbnb, VRBO, Hotels.com or Expedia.
        </p>
        {!isStay22Configured() && (
          <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <strong>Setup needed:</strong> add <code>NEXT_PUBLIC_STAY22_AID</code> to
            <code> .env.local</code> for hotel links to track to your Stay22 account.
          </p>
        )}
      </header>

      {countries.length > 0 && (
        <DestinationGrid
          title="By country"
          subtitle={`${countries.length} ${countries.length === 1 ? 'country' : 'countries'}`}
          items={countries}
        />
      )}

      {cities.length > 0 && (
        <DestinationGrid
          title="By city"
          subtitle={`${cities.length} ${cities.length === 1 ? 'city' : 'cities'}`}
          items={cities}
        />
      )}

      {indexable.length === 0 && (
        <div className="mt-16 rounded-3xl border border-dashed border-forest-900/15 p-12 text-center">
          <p className="font-light text-forest-900/60">
            No destinations published yet — add some in the CMS to populate this page.
          </p>
        </div>
      )}
    </div>
  );
}

function DestinationGrid({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle: string;
  items: StrapiDestination[];
}) {
  return (
    <section className="mt-16" data-testid={`hotels-grid-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
        <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-2xl">{title}</h2>
        <span className="text-sm font-light text-forest-900/50">{subtitle}</span>
      </header>

      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((d) => (
          <li key={d.id}>
            <DestinationCard destination={d} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DestinationCard({ destination }: { destination: StrapiDestination }) {
  const img = mediaUrl(destination.heroImage ?? null);
  const externalHref = allezLink({
    address: destination.name,
    subId: `hotels-${destination.slug}`,
  });

  return (
    <article
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-forest-900/10 bg-paper transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
      data-testid={`hotels-card-${destination.slug}`}
    >
      <Link href={`/hotels/${destination.slug}`} className="block">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={destination.name}
            className="aspect-[4/3] w-full object-cover transition duration-500 group-hover:scale-[1.01]"
          />
        ) : (
          <div className="aspect-[4/3] w-full bg-forest-900/10" />
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div>
          <div className="text-xs uppercase tracking-widest text-forest-900/60">
            {destination.type ?? 'Destination'}
            {destination.countryCode ? ` · ${destination.countryCode}` : ''}
          </div>
          <Link href={`/hotels/${destination.slug}`}>
            <h3 className="font-urbanist mt-2 text-lg font-bold text-forest-900 transition group-hover:text-forest-700">
              Hotels in {destination.name}
            </h3>
          </Link>
        </div>
        <div className="mt-auto flex items-center justify-between gap-3">
          <Link
            href={`/hotels/${destination.slug}`}
            className="text-sm font-medium text-forest-700 hover:underline"
          >
            See map →
          </Link>
          <a
            href={externalHref}
            target="_blank"
            rel="noopener sponsored"
            className="font-urbanist text-xs font-bold uppercase tracking-wider text-forest-700 hover:text-forest-600"
          >
            Search now ↗
          </a>
        </div>
      </div>
    </article>
  );
}
