import { listAirports } from '@/lib/strapi';
import AirportDirectory from '@/components/AirportDirectory';

export const revalidate = 60;

export const metadata = {
  title: 'Airport Directory',
  description: 'A searchable directory of commercial airports worldwide — IATA codes, cities, hubs, and route information.',
};

export default async function AirportsPage() {
  const airports = await listAirports().catch(() => []);

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="airports-page">
      <header className="max-w-3xl">
        <p className="chip">Directory</p>
        <h1 className="editorial-h mt-5 text-5xl font-black text-forest-900 lg:text-6xl">Airports, mapped</h1>
        <p className="mt-4 text-lg font-light text-forest-900/70">
          Commercial airports indexed by IATA code. Search by name, city, country, or code — click through for routes and detail.
        </p>
      </header>

      <AirportDirectory airports={airports} />
    </div>
  );
}
