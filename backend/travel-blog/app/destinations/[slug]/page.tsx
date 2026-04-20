import { notFound } from 'next/navigation';
import { getDestination, listArticles, mediaUrl } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const d = await getDestination(slug);
  if (!d) return { title: 'Not found' };
  return { title: d.name, description: d.description };
}

export default async function DestinationPage({ params }: Props) {
  const { slug } = await params;
  const destination = await getDestination(slug);
  if (!destination) notFound();

  const { data: articles } = await listArticles({ destination: slug, pageSize: 24 });
  const hero = mediaUrl(destination.heroImage ?? null);

  return (
    <div data-testid={`destination-page-${slug}`}>
      {/* Hero */}
      <section className="relative h-[55vh] min-h-[380px] overflow-hidden bg-forest-900">
        {hero && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={hero} alt={destination.name} className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-forest-950/90 via-forest-950/30 to-forest-950/10" />
        <div className="relative mx-auto flex h-full max-w-7xl flex-col justify-end px-6 pb-14 text-sand-100">
          <div className="text-xs uppercase tracking-widest opacity-80">
            {destination.type ?? 'Destination'}{destination.countryCode ? ` · ${destination.countryCode}` : ''}
          </div>
          <h1 className="editorial-h mt-3 text-6xl font-black lg:text-8xl">{destination.name}</h1>
          {destination.description && (
            <p className="mt-4 max-w-2xl text-lg opacity-90">{destination.description}</p>
          )}
        </div>
      </section>

      {/* Articles */}
      <div className="mx-auto max-w-7xl px-6 py-16">
        <h2 className="editorial-h text-3xl font-black text-forest-900">
          {articles.length === 0 ? 'No stories yet' : `${articles.length} stor${articles.length === 1 ? 'y' : 'ies'} from ${destination.name}`}
        </h2>
        {articles.length > 0 && (
          <div className="mt-10 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
            {articles.map((a) => <ArticleCard key={a.id} article={a} size="md" />)}
          </div>
        )}
      </div>
    </div>
  );
}
