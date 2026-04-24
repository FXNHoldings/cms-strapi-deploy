import { listAirlines } from '@/lib/strapi';
import AirlineDirectory from '@/components/AirlineDirectory';

export const revalidate = 60;

export const metadata = {
  title: 'Airline Directory',
  description: 'A searchable directory of airlines worldwide — IATA codes, hubs, and details for scheduled carriers, low-cost operators, and regional airlines.',
};

export default async function AirlinesPage() {
  const airlines = await listAirlines().catch(() => []);

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="airlines-page">
      <header className="max-w-3xl">
        <p className="chip">Directory</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">Airlines, indexed</h1>
        <p className="mt-4 text-lg font-light text-forest-900/70">
          Every airline we track — searchable by name, IATA code, country, and region. Click through for hub, fleet context, and more.
        </p>
      </header>

      <AirlineDirectory airlines={airlines} />
    </div>
  );
}
