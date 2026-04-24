import { listArticles } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
import Link from 'next/link';

export const revalidate = 60;

export const metadata = {
  title: 'All stories',
  description: 'Every travel guide, flight hack, and hotel review we\'ve published.',
};

export default async function ArticlesPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = (sp.q || '').trim();
  const { data, meta } = await listArticles({ page, pageSize: 12, q });
  const totalPages = meta.pagination.pageCount;

  return (
    <div className="mx-auto max-w-7xl px-6 py-16" data-testid="articles-page">
      <header className="max-w-3xl">
        <p className="chip">Archive</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">
          {q ? `Search results for "${q}"` : "Every story we've written"}
        </h1>
      </header>

      <form
        action="/articles"
        className="mt-8 flex max-w-3xl items-center gap-3 rounded-xl border border-primary-emphasis/20 bg-white px-4 py-3 shadow-sm"
        data-testid="articles-search"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 shrink-0 text-primary-emphasis"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search stories, places, flights, hotels..."
          className="min-w-0 flex-1 bg-transparent text-base text-forest-900 outline-none placeholder:text-forest-900/45"
          data-testid="articles-search-input"
        />
        <button
          type="submit"
          className="rounded-[0.3rem] bg-primary-emphasis px-4 py-2 font-urbanist text-xs font-bold uppercase tracking-wider text-white transition hover:bg-primary-emphasis-hover"
        >
          Search
        </button>
      </form>

      {data.length === 0 ? (
        <p className="mt-20 text-center text-forest-900/60">
          {q ? `No stories matched "${q}".` : 'No articles published yet.'}
        </p>
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
                href={`/articles?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) }).toString()}`}
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
