import Link from 'next/link';
import { mediaUrl, type StrapiDestination } from '@/lib/strapi';

export default function FeaturedCountries({ countries }: { countries: StrapiDestination[] }) {
  if (countries.length === 0) return null;

  return (
    <section className="py-12" data-testid="home-countries">
      <div className="mx-auto max-w-7xl px-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <h2 className="font-urbanist text-2xl font-bold leading-tight text-forest-900 sm:text-3xl">
              Explore by country
            </h2>
            <p className="mt-3 text-sm leading-6 text-ink/75 sm:text-base">
              Country guides, airports, airlines, and flights — browse every country we cover.
            </p>
          </div>
          <Link
            href="/destinations"
            className="inline-flex w-fit items-center justify-center rounded-[0.3rem] border border-forest-900 px-4 py-2 font-urbanist text-xs font-bold uppercase tracking-wider text-forest-900 transition hover:bg-primary-emphasis hover:text-white"
            data-testid="home-countries-all"
          >
            See all
          </Link>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {countries.map((c) => (
            <CountryTile key={c.id} destination={c} />
          ))}
        </div>
      </div>
    </section>
  );
}

function CountryTile({ destination: d }: { destination: StrapiDestination }) {
  const img = mediaUrl(d.heroImage ?? null);
  return (
    <Link
      href={`/destinations/${d.slug}`}
      className="group relative block aspect-[3/4] overflow-hidden rounded-lg bg-forest-800"
      data-testid={`home-country-${d.slug}`}
    >
      {img && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={d.name}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
          loading="lazy"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-forest-950/85 via-forest-950/25 to-transparent" />
      <div className="absolute inset-x-3 bottom-3 text-white">
        {d.countryCode && (
          <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/70">
            {d.countryCode}
          </div>
        )}
        <div className="mt-0.5 font-urbanist text-base font-bold leading-tight">
          {d.name}
        </div>
      </div>
    </Link>
  );
}
