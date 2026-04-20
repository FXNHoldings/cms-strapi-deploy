import { notFound } from 'next/navigation';
import { getCategory, listArticles } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const c = await getCategory(slug);
  if (!c) return { title: 'Not found' };
  return { title: c.name, description: c.description };
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const category = await getCategory(slug);
  if (!category) notFound();

  const { data: articles } = await listArticles({ category: slug, pageSize: 24 });

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid={`category-page-${slug}`}>
      <header className="max-w-3xl">
        <p className="chip">Category</p>
        <h1 className="editorial-h mt-5 text-5xl font-black text-forest-900 lg:text-6xl">{category.name}</h1>
        {category.description && (
          <p className="mt-5 text-xl text-ink/70">{category.description}</p>
        )}
      </header>

      {articles.length === 0 ? (
        <p className="mt-20 text-center text-forest-900/60">No articles in this category yet.</p>
      ) : (
        <div className="mt-14 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
          {articles.map((a) => <ArticleCard key={a.id} article={a} size="md" />)}
        </div>
      )}
    </div>
  );
}
