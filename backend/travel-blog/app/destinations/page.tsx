import { listDestinations } from '@/lib/strapi';
import DestinationsDirectory from '@/components/DestinationsDirectory';
import { Suspense } from 'react';

export const revalidate = 60;

export const metadata = {
  title: 'Destinations',
  description: "Every place we've written about — regions, countries, and cities worth your time. Search, filter, and browse.",
};

export default async function DestinationsPage() {
  const destinations = await listDestinations().catch(() => []);

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="destinations-page">
      <header className="max-w-3xl">
        <p className="chip">Places</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">
          Where we've been
        </h1>
        <p className="mt-5 text-xl text-ink/70">
          {destinations.length} destinations and counting. Browse by region, country, or city — or search for somewhere specific.
        </p>
      </header>

      <Suspense>
        <DestinationsDirectory destinations={destinations} />
      </Suspense>
    </div>
  );
}
