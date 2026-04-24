import { notFound } from 'next/navigation';
import { format } from 'date-fns';
import { marked } from 'marked';
import Link from 'next/link';
import { getArticle, listArticles, mediaUrl } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const a = await getArticle(slug);
  if (!a) return { title: 'Not found' };
  const ogImg = mediaUrl(a.ogImage ?? a.coverImage ?? null);
  return {
    title: a.seoTitle || a.title,
    description: a.seoDescription || a.excerpt,
    openGraph: {
      title: a.seoTitle || a.title,
      description: a.seoDescription || a.excerpt,
      type: 'article',
      publishedTime: a.publishedAt,
      authors: a.author ? [a.author.name] : undefined,
      images: ogImg ? [{ url: ogImg }] : undefined,
    },
  };
}

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) notFound();

  const html = await marked.parse(article.content || '', { async: true });
  const hero = mediaUrl(article.coverImage ?? null);
  const date = article.publishedAt ? format(new Date(article.publishedAt), 'd MMMM yyyy') : '';

  // Related by category
  let related: Awaited<ReturnType<typeof listArticles>>['data'] = [];
  if (article.category) {
    const { data } = await listArticles({ category: article.category.slug, pageSize: 4 });
    related = data.filter((x) => x.id !== article.id).slice(0, 3);
  }

  return (
    <article data-testid="article-page">
      {/* Hero */}
      <header className="mx-auto max-w-5xl px-6 pt-12">
        <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-widest text-forest-800/70">
          {article.category && (
            <Link href={`/category/${article.category.slug}`} className="chip hover:bg-forest-800/10">
              {article.category.name}
            </Link>
          )}
          {date && <time dateTime={article.publishedAt}>{date}</time>}
          {article.readingTimeMinutes ? <span>· {article.readingTimeMinutes} min read</span> : null}
        </div>
        <h1 className="editorial-h mt-6 text-3xl font-bold leading-tight text-forest-900" data-testid="article-title">
          {article.title}
        </h1>
        {article.excerpt && (
          <p className="mt-6 max-w-3xl text-base text-ink/75 sm:text-lg">{article.excerpt}</p>
        )}
        {article.author && (
          <div className="mt-8 flex items-center gap-3 text-sm text-forest-900/80">
            {mediaUrl(article.author.avatar ?? null) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl(article.author.avatar ?? null)!} alt={article.author.name} className="h-10 w-10 rounded-full object-cover" />
            )}
            <span>
              by <strong className="text-forest-900">{article.author.name}</strong>
            </span>
          </div>
        )}
      </header>

      {hero && (
        <div className="mx-auto mt-10 max-w-6xl px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={hero}
            alt={article.coverImage?.alternativeText || article.title}
            className="aspect-[16/9] w-full rounded-3xl object-cover shadow-2xl shadow-forest-900/10"
          />
        </div>
      )}

      {/* Body */}
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div
          className="prose-article"
          data-testid="article-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {article.gallery && article.gallery.length > 0 && (
          <div className="mt-12" data-testid="article-gallery">
            <h3 className="editorial-h text-sm uppercase tracking-widest text-forest-800/70">
              Gallery
            </h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {article.gallery.map((img, i) => {
                const url = mediaUrl(img);
                if (!url) return null;
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={url}
                    alt={img.alternativeText || `${article.title} — image ${i + 1}`}
                    className="aspect-[4/3] w-full rounded-lg object-cover"
                    loading="lazy"
                  />
                );
              })}
            </div>
          </div>
        )}

        {article.destinations && article.destinations.length > 0 && (
          <div className="mt-12 border-t border-forest-900/10 pt-8">
            <h3 className="editorial-h text-sm uppercase tracking-widest text-forest-800/70">Places in this story</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {article.destinations.map((d) => (
                <Link key={d.id} href={`/destinations/${d.slug}`} className="chip hover:bg-forest-800/10">
                  {d.name}
                </Link>
              ))}
            </div>
          </div>
        )}

        {article.tags && article.tags.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-2">
            {article.tags.map((t) => (
              <span key={t.id} className="rounded-full border border-forest-900/15 px-3 py-1 text-xs text-forest-900/70">
                #{t.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Related */}
      {related.length > 0 && (
        <section className="border-t border-forest-900/10 bg-forest-900/[0.02]">
          <div className="mx-auto max-w-7xl px-6 py-16" data-testid="related-section">
            <h2 className="editorial-h text-3xl font-bold text-forest-900">Keep reading</h2>
            <div className="mt-10 grid gap-10 md:grid-cols-3">
              {related.map((a) => <ArticleCard key={a.id} article={a} size="sm" />)}
            </div>
          </div>
        </section>
      )}
    </article>
  );
}
