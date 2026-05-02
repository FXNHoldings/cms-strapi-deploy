import { notFound } from 'next/navigation';
import { getCategory, listArticles, listDestinationArticles } from '@/lib/strapi';
import { findSection } from '@/lib/sections';
import ArticleCard from '@/components/ArticleCard';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

/** Look up category meta from Strapi first; fall back to the hardcoded home sections. */
async function resolveCategory(slug: string) {
  const strapi = await getCategory(slug).catch(() => null);
  if (strapi) {
    return {
      name: strapi.name,
      description: strapi.description ?? findSection(slug)?.description,
      tagline: findSection(slug)?.tagline,
      fromStrapi: true as const,
    };
  }
  const section = findSection(slug);
  if (section) {
    return {
      name: section.title,
      description: section.description,
      tagline: section.tagline,
      fromStrapi: false as const,
    };
  }
  return null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const c = await resolveCategory(slug);
  if (!c) return { title: 'Not found' };
  return {
    title: c.name,
    description: c.description,
    alternates: { canonical: `/category/${slug}` },
  };
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const category = await resolveCategory(slug);
  if (!category) notFound();

  const { data: articles } = await (slug === 'destinations'
    ? listDestinationArticles({ pageSize: 24 })
    : listArticles({ category: slug, pageSize: 24 })
  ).catch(
    () => ({ data: [], meta: { pagination: { page: 1, pageSize: 24, pageCount: 0, total: 0 } } }),
  );

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid={`category-page-${slug}`}>
      <header className="max-w-3xl">
        <p className="chip">Category</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">{category.name}</h1>
        {category.tagline && (
          <p className="font-urbanist mt-4 text-sm uppercase tracking-wider text-forest-900/60">{category.tagline}</p>
        )}
        {category.description && (
          <p className="mt-5 text-xl text-ink/70">{category.description}</p>
        )}
      </header>

      {articles.length === 0 ? (
        <p className="mt-20 text-center text-forest-900/60" data-testid="category-empty">
          No articles in this category yet. Check back soon.
        </p>
      ) : (
        <div className="mt-14 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
          {articles.map((a) => <ArticleCard key={a.id} article={a} size="md" />)}
        </div>
      )}
    </div>
  );
}
