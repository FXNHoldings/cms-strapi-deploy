import { listAirports, listCountries } from '@/lib/strapi';
import CountriesDirectory, { type CountryRow } from '@/components/CountriesDirectory';

export const revalidate = 60;

export const metadata = {
  title: 'Countries — travel directory',
  description:
    'Browse countries with commercial air service. ISO country codes, airport counts, cities, and regional groupings — click through for airlines, airports, and routes.',
};

export default async function CountriesPage() {
  const [strapiCountries, airports] = await Promise.all([
    listCountries().catch(() => []),
    listAirports().catch(() => []),
  ]);

  // Build aggregates (airport + city counts) from airports keyed by ISO code.
  const agg = new Map<string, { airports: number; cities: Set<string>; region: CountryRow['region'] }>();
  for (const a of airports) {
    const code = (a.countryCode || '').toUpperCase();
    if (!code) continue;
    let row = agg.get(code);
    if (!row) {
      row = { airports: 0, cities: new Set<string>(), region: a.region ?? null };
      agg.set(code, row);
    }
    row.airports += 1;
    if (a.city) row.cities.add(a.city);
    if (!row.region && a.region) row.region = a.region;
  }

  let countries: CountryRow[];
  if (strapiCountries.length > 0) {
    // Use the Countries collection as the source of truth, enriched with aggregates.
    countries = strapiCountries
      .map((c) => {
        const a = agg.get(c.code.toUpperCase());
        return {
          code: c.code.toUpperCase(),
          name: c.name,
          region: c.region ?? a?.region ?? null,
          airportCount: a?.airports ?? 0,
          cityCount: a?.cities.size ?? 0,
        };
      })
      .sort((x, y) => x.name.localeCompare(y.name));
  } else {
    // Fallback: aggregate-only view (works before the countries ingest runs).
    countries = Array.from(agg.entries())
      .map(([code, a]) => {
        const airport = airports.find((x) => (x.countryCode || '').toUpperCase() === code);
        return {
          code,
          name: airport?.country || code,
          region: a.region,
          airportCount: a.airports,
          cityCount: a.cities.size,
        };
      })
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="countries-page">
      <header className="max-w-3xl">
        <p className="chip">Directory</p>
        <h1 className="editorial-h mt-5 text-5xl font-black text-forest-900 lg:text-6xl">Countries, mapped</h1>
        <p className="mt-4 text-lg font-light text-forest-900/70">
          Every country with commercial air service indexed from TravelPayouts. Search by name or ISO code — click through for the country&apos;s airports, airlines, and top routes.
        </p>
      </header>

      <CountriesDirectory countries={countries} />
    </div>
  );
}
