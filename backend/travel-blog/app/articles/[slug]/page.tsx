import { notFound } from 'next/navigation';
import { format } from 'date-fns';
import { marked } from 'marked';
import Link from 'next/link';
import { getArticle, listArticles, mediaUrl } from '@/lib/strapi';
import ArticleCard from '@/components/ArticleCard';
import ShareButtons from '@/components/ShareButtons';
import { SECTIONS } from '@/lib/sections';
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
    alternates: { canonical: `/articles/${a.slug}` },
    openGraph: {
      title: a.seoTitle || a.title,
      description: a.seoDescription || a.excerpt,
      type: 'article',
      publishedTime: a.publishedAt,
      modifiedTime: a.updatedAt,
      authors: a.author ? [a.author.name] : undefined,
      images: ogImg ? [{ url: ogImg }] : undefined,
      url: `/articles/${a.slug}`,
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

  // Related by category + sidebar latest
  const [relatedRes, latestRes] = await Promise.all([
    article.category
      ? listArticles({ category: article.category.slug, pageSize: 4 }).catch(() => ({ data: [] as Awaited<ReturnType<typeof listArticles>>['data'] }))
      : Promise.resolve({ data: [] as Awaited<ReturnType<typeof listArticles>>['data'] }),
    listArticles({ pageSize: 6 }).catch(() => ({ data: [] as Awaited<ReturnType<typeof listArticles>>['data'] })),
  ]);
  const related = relatedRes.data.filter((x) => x.id !== article.id).slice(0, 3);
  const latest = latestRes.data.filter((x) => x.id !== article.id).slice(0, 5);

  const articleUrl = `https://www.originfacts.com/articles/${article.slug}`;
  const articleImage = mediaUrl(article.ogImage ?? article.coverImage ?? null);

  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.seoDescription || article.excerpt,
    image: articleImage ? [articleImage] : undefined,
    datePublished: article.publishedAt,
    dateModified: article.updatedAt || article.publishedAt,
    author: article.author?.name
      ? { '@type': 'Person', name: article.author.name }
      : { '@type': 'Organization', name: 'Originfacts' },
    publisher: {
      '@type': 'Organization',
      name: 'Originfacts',
      logo: {
        '@type': 'ImageObject',
        url: 'https://www.originfacts.com/brand/logo/logo.svg',
      },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': articleUrl },
    url: articleUrl,
    articleSection: article.category?.name,
    keywords: article.seoKeywords,
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.originfacts.com/' },
      ...(article.category
        ? [{
            '@type': 'ListItem',
            position: 2,
            name: article.category.name,
            item: `https://www.originfacts.com/category/${article.category.slug}`,
          }]
        : []),
      {
        '@type': 'ListItem',
        position: article.category ? 3 : 2,
        name: article.title,
        item: articleUrl,
      },
    ],
  };

  return (
    <article data-testid="article-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="mx-auto max-w-7xl px-6 pt-8"
        data-testid="breadcrumb"
      >
        <ol
          itemScope
          itemType="https://schema.org/BreadcrumbList"
          className="flex flex-wrap items-center gap-2 text-xs text-forest-900/60"
        >
          <li
            itemProp="itemListElement"
            itemScope
            itemType="https://schema.org/ListItem"
            className="flex items-center gap-2"
          >
            <Link href="/" itemProp="item" className="hover:text-primary-emphasis">
              <span itemProp="name">Home</span>
            </Link>
            <meta itemProp="position" content="1" />
            <span aria-hidden className="text-forest-900/30">/</span>
          </li>
          {article.category && (
            <li
              itemProp="itemListElement"
              itemScope
              itemType="https://schema.org/ListItem"
              className="flex items-center gap-2"
            >
              <Link
                href={`/category/${article.category.slug}`}
                itemProp="item"
                className="hover:text-primary-emphasis"
              >
                <span itemProp="name">{article.category.name}</span>
              </Link>
              <meta itemProp="position" content="2" />
              <span aria-hidden className="text-forest-900/30">/</span>
            </li>
          )}
          <li
            itemProp="itemListElement"
            itemScope
            itemType="https://schema.org/ListItem"
            aria-current="page"
            className="truncate text-forest-900"
          >
            <span itemProp="name">{article.title}</span>
            <meta itemProp="position" content={article.category ? '3' : '2'} />
          </li>
        </ol>
      </nav>

      {/* Hero */}
      <header className="mx-auto max-w-7xl px-6 pt-6">
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
        <div className="mx-auto mt-10 max-w-7xl px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={hero}
            alt={article.coverImage?.alternativeText || article.title}
            className="aspect-[16/9] w-full rounded-3xl object-cover shadow-2xl shadow-forest-900/10"
          />
        </div>
      )}

      {/* Body + sidebar */}
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0" data-testid="article-main">
            <div className="mb-10">
              <ShareButtons title={article.title} slug={article.slug} />
            </div>
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

          <aside className="lg:sticky lg:top-24 lg:self-start" data-testid="article-sidebar">
            <div className="rounded border border-forest-900/10 bg-paper p-5">
              <h3 className="editorial-h text-sm uppercase tracking-normal text-forest-800/70">
                Categories
              </h3>
              <ul className="mt-3 space-y-2 text-sm" data-testid="sidebar-categories">
                {SECTIONS.map((s) => (
                  <li key={s.slug}>
                    <Link
                      href={`/category/${s.slug}`}
                      className={`block rounded-md px-2 py-1.5 transition hover:bg-forest-900/5 ${
                        article.category?.slug === s.slug
                          ? 'font-semibold text-primary-emphasis'
                          : 'text-forest-900'
                      }`}
                    >
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {latest.length > 0 && (
              <div className="mt-6 rounded border border-forest-900/10 bg-paper p-5">
                <h3 className="editorial-h text-sm uppercase tracking-normal text-forest-800/70">
                  Latest posts
                </h3>
                <ul className="mt-3 space-y-4" data-testid="sidebar-latest">
                  {latest.map((p) => {
                    const thumb = mediaUrl(p.coverImage ?? null);
                    const pubDate = p.publishedAt ? format(new Date(p.publishedAt), 'd MMM yyyy') : '';
                    return (
                      <li key={p.id}>
                        <Link href={`/articles/${p.slug}`} className="group grid grid-cols-[64px_minmax(0,1fr)] gap-3">
                          <div className="overflow-hidden rounded-md bg-forest-900/5">
                            {thumb ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={thumb}
                                alt={p.coverImage?.alternativeText || p.title}
                                className="aspect-square h-full w-full object-cover transition duration-300 group-hover:scale-105"
                                loading="lazy"
                              />
                            ) : (
                              <div className="aspect-square bg-gradient-to-br from-primary-hover to-primary-pressed" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="line-clamp-2 text-sm font-semibold leading-snug text-forest-900 transition group-hover:text-primary-highlight">
                              {p.title}
                            </p>
                            {pubDate && (
                              <p className="mt-1 text-xs text-forest-900/60">{pubDate}</p>
                            )}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </aside>
        </div>
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
