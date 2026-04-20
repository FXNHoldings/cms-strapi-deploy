import Link from 'next/link';
import { listArticles, listDestinations, listCategories, mediaUrl } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';

export const revalidate = 60;

export default async function HomePage() {
  let articles: Awaited<ReturnType<typeof listArticles>>['data'] = [];
  let destinations: Awaited<ReturnType<typeof listDestinations>> = [];
  let categories: Awaited<ReturnType<typeof listCategories>> = [];

  try {
    const [a, d, c] = await Promise.all([listArticles({ pageSize: 13 }), listDestinations(), listCategories()]);
    articles = a.data;
    destinations = d;
    categories = c;
  } catch (e) {
    // Strapi unreachable at build time — render empty-state
    console.error('[home] Strapi fetch failed', e);
  }

  const [hero, ...rest] = articles;
  const featured = rest.slice(0, 4);
  const recent = rest.slice(4);

  return (
    <div className="mx-auto max-w-7xl px-6 py-12" data-testid="home-page">
      {/* Hero */}
      <section className="grid gap-10 lg:grid-cols-12 lg:gap-14" data-testid="hero-section">
        <div className="lg:col-span-7">
          {hero ? (
            <ArticleCard article={hero} size="lg" />
          ) : (
            <div className="rounded-2xl bg-forest-900/5 p-16 text-center text-forest-900/60">
              <p className="editorial-h text-2xl">No published articles yet.</p>
              <p className="mt-2 text-sm">Publish your first article in the CMS to see it here.</p>
            </div>
          )}
        </div>
        <aside className="flex flex-col justify-between lg:col-span-5">
          <div>
            <p className="chip" data-testid="hero-tagline">Slow travel · Cheap flights · Smart stays</p>
            <h1 className="editorial-h mt-6 text-5xl font-black leading-[0.95] text-forest-900 lg:text-7xl">
              Go further,<br />
              <em className="font-light text-terracotta-700">pay less</em>,<br />
              stay longer.
            </h1>
            <p className="mt-6 max-w-md text-lg text-ink/75">
              Hand-picked travel writing for people who'd rather spend on the trip than on the booking. New guides every week.
            </p>
          </div>
          <div className="mt-10 flex flex-wrap gap-3" data-testid="category-chips">
            {categories.slice(0, 6).map((c) => (
              <Link key={c.id} href={`/category/${c.slug}`} className="chip transition hover:bg-forest-800 hover:text-sand-100">
                {c.name}
              </Link>
            ))}
          </div>
        </aside>
      </section>

      {/* Featured */}
      {featured.length > 0 && (
        <section className="mt-24" data-testid="featured-section">
          <div className="flex items-end justify-between">
            <h2 className="editorial-h text-3xl font-black text-forest-900 lg:text-4xl">This week's picks</h2>
            <Link href="/articles" className="text-sm font-medium text-terracotta-700 hover:underline">
              All stories →
            </Link>
          </div>
          <div className="mt-10 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((a) => <ArticleCard key={a.id} article={a} size="sm" />)}
          </div>
        </section>
      )}

      {/* Destinations strip */}
      {destinations.length > 0 && (
        <section className="mt-24" data-testid="destinations-section">
          <h2 className="editorial-h text-3xl font-black text-forest-900 lg:text-4xl">Where next</h2>
          <div className="mt-10 flex snap-x gap-6 overflow-x-auto pb-4">
            {destinations.slice(0, 10).map((d) => {
              const img = mediaUrl(d.heroImage ?? null);
              return (
                <Link
                  key={d.id}
                  href={`/destinations/${d.slug}`}
                  className="group relative aspect-[3/4] w-72 flex-none snap-start overflow-hidden rounded-2xl bg-forest-800"
                  data-testid={`destination-card-${d.slug}`}
                >
                  {img && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt={d.name} className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-110" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-forest-950/90 via-forest-950/20 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 p-5 text-sand-100">
                    <div className="text-xs uppercase tracking-widest opacity-70">{d.type ?? 'Destination'}</div>
                    <div className="editorial-h text-2xl font-bold">{d.name}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent */}
      {recent.length > 0 && (
        <section className="mt-24" data-testid="recent-section">
          <h2 className="editorial-h text-3xl font-black text-forest-900 lg:text-4xl">Latest</h2>
          <div className="mt-10 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
            {recent.map((a) => <ArticleCard key={a.id} article={a} size="md" />)}
          </div>
        </section>
      )}
    </div>
  );
}
