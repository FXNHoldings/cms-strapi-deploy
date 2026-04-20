import { listArticles } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
import Link from 'next/link';

export const revalidate = 60;

export const metadata = {
  title: 'All stories',
  description: 'Every travel guide, flight hack, and hotel review we\'ve published.',
};

export default async function ArticlesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, meta } = await listArticles({ page, pageSize: 12 });
  const totalPages = meta.pagination.pageCount;

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="articles-page">
      <header className="max-w-3xl">
        <p className="chip">Archive</p>
        <h1 className="editorial-h mt-5 text-5xl font-black text-forest-900 lg:text-6xl">Every story we've written</h1>
      </header>

      {data.length === 0 ? (
        <p className="mt-20 text-center text-forest-900/60">No articles published yet.</p>
      ) : (
        <div className="mt-14 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
          {data.map((a) => <ArticleCard key={a.id} article={a} size="md" />)}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="mt-16 flex justify-center gap-3" data-testid="pagination">
          {Array.from({ length: totalPages }).map((_, i) => {
            const n = i + 1;
            const active = n === page;
            return (
              <Link
                key={n}
                href={`/articles?page=${n}`}
                className={`rounded-full border px-4 py-2 text-sm ${active ? 'border-forest-900 bg-forest-900 text-sand-100' : 'border-forest-900/20 text-forest-900 hover:bg-forest-900/5'}`}
                data-testid={`page-${n}`}
              >
                {n}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
