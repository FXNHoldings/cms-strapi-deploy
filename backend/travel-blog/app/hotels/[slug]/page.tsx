import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  getDestination,
  listArticles,
  listCitiesByCountryCode,
  mediaUrl,
  type StrapiDestination,
} from '@/lib/strapi';
import { isStay22Configured, allezLink } from '@/lib/stay22';
import Stay22Map from '@/components/Stay22Map';
import ArticleCard from '@/components/ArticleCard';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const d = await getDestination(slug);
  if (!d) return { title: 'Not found' };
  return {
    title: `Hotels in ${d.name}`,
    description: `Find hotels, vacation rentals and Airbnbs in ${d.name} — compare Booking.com, Airbnb, VRBO, Hotels.com and Expedia in one search.`,
  };
}

export default async function HotelDestinationPage({ params }: Props) {
  const { slug } = await params;
  const destination = await getDestination(slug);
  if (!destination) notFound();

  const isCountry = destination.type === 'country' && !!destination.countryCode;

  const [{ data: articles }, cities] = await Promise.all([
    listArticles({ destination: slug, pageSize: 4 }).catch(() => ({
      data: [],
      meta: { pagination: { page: 1, pageSize: 0, pageCount: 0, total: 0 } },
    })),
    isCountry
      ? listCitiesByCountryCode(destination.countryCode as string).catch(
          () => [] as StrapiDestination[],
        )
      : Promise.resolve<StrapiDestination[]>([]),
  ]);

  const hero = mediaUrl(destination.heroImage ?? null);
  const subId = `hotels-${slug}`;
  const ctaHref = allezLink({ address: destination.name, subId });

  return (
    <article data-testid={`hotels-page-${slug}`}>
      {/* Hero */}
      <section className="relative h-[45vh] min-h-[320px] overflow-hidden bg-forest-900">
        {hero && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hero}
            alt={destination.name}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-forest-950/90 via-forest-950/40 to-forest-950/10" />
        <div className="relative mx-auto flex h-full max-w-7xl flex-col justify-end px-6 pb-12 text-sand-100">
          <div className="text-xs uppercase tracking-widest opacity-80">
            Hotels &amp; stays
            {destination.countryCode ? ` · ${destination.countryCode}` : ''}
          </div>
          <h1 className="editorial-h mt-3 text-3xl font-bold sm:text-4xl">
            Hotels in {destination.name}
          </h1>
          <p className="mt-4 max-w-2xl text-base opacity-90 sm:text-lg">
            {isCountry
              ? `Pick a city to see hotels and vacation rentals on a live map — or jump straight to a country-wide search.`
              : `Compare prices across Booking.com, Airbnb, VRBO, Hotels.com and Expedia in one search — boutique hotels, budget rooms, and vacation rentals on a live map.`}
          </p>
          <div className="mt-6">
            <a
              href={ctaHref}
              target="_blank"
              rel="noopener sponsored"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-sand-100 px-6 py-3 font-urbanist text-sm font-bold uppercase tracking-wider text-forest-900 transition hover:bg-sand-200"
              data-testid={`hotels-hero-cta-${slug}`}
            >
              {isCountry
                ? `Search hotels across ${destination.name}`
                : `Find hotels in ${destination.name}`}
              <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </section>

      {/* Country: cities grid. City: live map. */}
      {isCountry ? (
        <CitiesGrid country={destination} cities={cities} />
      ) : isStay22Configured() ? (
        <div className="mt-16">
          <Stay22Map
            address={destination.name}
            title={destination.name}
            subId={subId}
            adults={2}
          />
        </div>
      ) : (
        <section className="mx-auto mt-16 max-w-7xl px-6">
          <div className="rounded-md border border-amber-300 bg-amber-50 px-6 py-5 text-sm text-amber-900">
            <strong>Setup needed:</strong> add <code>NEXT_PUBLIC_STAY22_AID</code> to{' '}
            <code>.env.local</code> to enable the live hotel map for {destination.name}.
          </div>
        </section>
      )}

      {/* Related stories */}
      {articles.length > 0 && (
        <section className="mx-auto mt-20 max-w-7xl px-6 pb-20" data-testid="hotels-stories">
          <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
            <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-2xl">
              Stories from {destination.name}
            </h2>
            <Link
              href={`/destinations/${slug}`}
              className="text-sm font-medium text-forest-700 hover:underline"
            >
              All stories →
            </Link>
          </header>
          <div className="mt-10 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {articles.map((a) => (
              <ArticleCard key={a.id} article={a} size="compact" />
            ))}
          </div>
        </section>
      )}

      {/* Footer back-link */}
      <section className="mx-auto max-w-7xl px-6 pb-20">
        <Link
          href="/hotels"
          className="text-sm font-medium text-forest-700 hover:underline"
        >
          ← All destinations
        </Link>
      </section>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Cities grid — only rendered for country-type destinations.                 */
/* Country-level Stay22 maps return empty results once dates are applied      */
/* (the search radius can't cover a whole country), so we replace the map     */
/* with city cards that each open a working city-level map.                   */
/* -------------------------------------------------------------------------- */

function CitiesGrid({
  country,
  cities,
}: {
  country: StrapiDestination;
  cities: StrapiDestination[];
}) {
  if (cities.length === 0) {
    return (
      <section className="mx-auto mt-16 max-w-7xl px-6" data-testid="hotels-no-cities">
        <div className="rounded-md border border-forest-900/10 bg-forest-50 px-6 py-5 text-sm text-forest-900/75">
          No cities published for {country.name} yet — for now, use the search button above
          to browse hotels across the country.
        </div>
      </section>
    );
  }

  return (
    <section
      className="mx-auto mt-16 max-w-7xl px-6"
      data-testid={`hotels-cities-${country.slug}`}
    >
      <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
        <div>
          <p className="chip">Cities in {country.name}</p>
          <h2 className="editorial-h mt-2 text-2xl font-bold text-forest-900 lg:text-2xl">
            Where to stay in {country.name}
          </h2>
        </div>
        <span className="text-sm font-light text-forest-900/50">
          {cities.length} {cities.length === 1 ? 'city' : 'cities'}
        </span>
      </header>

      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cities.map((c) => (
          <li key={c.id}>
            <CityCard city={c} />
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs text-forest-900/50">
        Each city opens a live map of hotels and vacation rentals — book through
        Booking.com, Airbnb, VRBO, Hotels.com or Expedia.
      </p>
    </section>
  );
}

function CityCard({ city }: { city: StrapiDestination }) {
  const img = mediaUrl(city.heroImage ?? null);
  return (
    <Link
      href={`/hotels/${city.slug}`}
      className="group flex h-full overflow-hidden rounded-lg border border-forest-900/10 bg-paper transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
      data-testid={`hotels-city-card-${city.slug}`}
    >
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={city.name}
          className="h-28 w-32 shrink-0 object-cover transition duration-500 group-hover:scale-[1.02]"
        />
      ) : (
        <div className="h-28 w-32 shrink-0 bg-forest-900/10" />
      )}
      <div className="flex flex-1 flex-col justify-center p-4">
        <div className="text-xs uppercase tracking-widest text-forest-900/60">City</div>
        <div className="font-urbanist mt-1 text-base font-bold text-forest-900 transition group-hover:text-forest-700">
          {city.name}
        </div>
        <div className="mt-2 text-xs font-medium text-forest-700">See map →</div>
      </div>
    </Link>
  );
}
