import { listRoutes } from '@/lib/strapi';
import RouteDirectory from '@/components/RouteDirectory';

export const revalidate = 60;

export const metadata = {
  title: 'Flight Routes',
  description: 'Every route we track — searchable by origin, destination, IATA code, or country. Click through for carriers, flight time, and booking.',
};

export default async function FlightsPage() {
  const routes = await listRoutes().catch(() => []);

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="flights-page">
      <header className="max-w-3xl">
        <p className="chip">Directory</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">Flight routes, charted</h1>
        <p className="mt-4 text-lg font-light text-forest-900/70">
          City-pair routes indexed for carriers, flight time, and distance. Search by origin, destination, IATA, or country — click through to book.
        </p>
      </header>

      <RouteDirectory routes={routes} />
    </div>
  );
}
