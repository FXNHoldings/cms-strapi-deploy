import type { Metadata } from 'next';
import { listAirports } from '@/lib/strapi';
import { HUB_AIRPORT_SET } from '@/lib/hub-airports';
import HubAirportsDirectory from '@/components/HubAirportsDirectory';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Top international airport hubs',
  description:
    "The world's busiest international airports — 100 hubs across 6 continents, with terminal, runway and airline detail for each.",
};

export default async function HubsPage() {
  const all = await listAirports().catch(() => []);
  const hubs = all.filter((a) => a.iata && HUB_AIRPORT_SET.has(a.iata.toUpperCase()));

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="airport-hubs-page">
      <header className="max-w-3xl">
        <p className="chip">Top hubs</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">
          Top {HUB_AIRPORT_SET.size} international airport hubs
        </h1>
        <p className="mt-4 text-lg font-light text-forest-900/70">
          The world's busiest international gateways — across {countContinents(hubs)} continents and{' '}
          {countCountries(hubs)} countries. Filter by continent, search, or click through for details.
        </p>
      </header>

      <HubAirportsDirectory airports={hubs} />
    </div>
  );
}

function countContinents(airports: Awaited<ReturnType<typeof listAirports>>): number {
  return new Set(airports.map((a) => a.region).filter(Boolean)).size;
}

function countCountries(airports: Awaited<ReturnType<typeof listAirports>>): number {
  return new Set(airports.map((a) => a.country).filter(Boolean)).size;
}
