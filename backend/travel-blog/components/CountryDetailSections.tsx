import Link from 'next/link';
import { mediaUrl, type StrapiAirport, type StrapiAirline } from '@/lib/strapi';

export default function CountryDetailSections({
  countryName,
  airports,
  airlines,
}: {
  countryName: string;
  airports: StrapiAirport[];
  airlines: StrapiAirline[];
}) {
  return (
    <>
      {/* Airports */}
      <section className="mx-auto mt-16 max-w-7xl px-6" data-testid="country-airports">
        <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-2xl">
            Airports in {countryName}
          </h2>
          <span className="text-sm font-light text-forest-900/50">
            {airports.length} airport{airports.length === 1 ? '' : 's'}
          </span>
        </header>
        {airports.length === 0 ? (
          <p className="mt-10 text-forest-900/60">No airports indexed for {countryName} yet.</p>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {airports.slice(0, 60).map((a) => (
              <AirportCard key={a.id} airport={a} />
            ))}
          </div>
        )}
        {airports.length > 60 && (
          <p className="mt-4 text-xs text-forest-900/50">
            + {airports.length - 60} more — see the full{' '}
            <Link href="/airports" className="underline hover:text-forest-900">
              airports directory
            </Link>
            .
          </p>
        )}
      </section>

      {/* Airlines */}
      <section className="mx-auto mt-16 max-w-7xl px-6" data-testid="country-airlines">
        <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
          <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-2xl">
            Airlines based in {countryName}
          </h2>
          <span className="text-sm font-light text-forest-900/50">
            {airlines.length} airline{airlines.length === 1 ? '' : 's'}
          </span>
        </header>
        {airlines.length === 0 ? (
          <p className="mt-10 text-forest-900/60">No airlines tagged to {countryName} yet.</p>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {airlines.slice(0, 30).map((al) => {
              const logo = mediaUrl(al.logo ?? null);
              return (
                <Link
                  key={al.id}
                  href={`/airlines/${al.slug}`}
                  className="group flex items-center gap-4 rounded-lg border border-forest-900/10 bg-paper p-4 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
                >
                  <div className="flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-lg bg-forest-900/5">
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
                        <span className="flex-none rounded bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
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
    </>
  );
}

function AirportCard({ airport }: { airport: StrapiAirport }) {
  return (
    <Link
      href={`/airports/${airport.iata.toLowerCase()}`}
      className="group flex items-center justify-between gap-3 rounded-lg border border-forest-900/10 bg-paper px-4 py-3 transition hover:-translate-y-0.5 hover:border-forest-900/30"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="flex-none rounded bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
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
