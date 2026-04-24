import Link from 'next/link';
import {
  listArticles,
  listCountryDestinations,
  listDestinationArticles,
  mediaUrl,
  type StrapiArticle,
} from '@/lib/strapi';
import { SECTIONS } from '@/lib/sections';
import FeaturedCountries from '@/components/FeaturedCountries';

export const revalidate = 60;

export default async function HomePage() {
  const [perSection, countries] = await Promise.all([
    Promise.all(
      SECTIONS.map((s) => {
        const articles =
          s.slug === 'destinations'
            ? listDestinationArticles({ pageSize: 5 })
            : listArticles({ category: s.slug, pageSize: 5 });

        return articles.then((r) => r.data).catch(() => []);
      }),
    ),
    listCountryDestinations(12).catch(() => []),
  ]);

  const bySection = Object.fromEntries(SECTIONS.map((s, i) => [s.slug, perSection[i] as StrapiArticle[]]));

  // Latest across all categories, de-duped (same article can live in multiple sections)
  const latest: StrapiArticle[] = [];
  const seenIds = new Set<number>();
  for (const a of perSection.flat().sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  )) {
    if (seenIds.has(a.id)) continue;
    seenIds.add(a.id);
    latest.push(a);
  }
  const hero = latest[0];
  const side = latest.slice(1, 5);

  return (
    <div data-testid="home-page">
      <Hero hero={hero} side={side} />

      <FeaturedCountries countries={countries} />

      {SECTIONS.map((s) => {
        const posts = bySection[s.slug] ?? [];
        if (posts.length === 0) return <EmptySection key={s.slug} section={s} />;
        return <EditorialSection key={s.slug} section={s} posts={posts} />;
      })}
    </div>
  );
}

/* ---------- HERO ---------- */

function Hero({ hero, side }: { hero?: StrapiArticle; side: StrapiArticle[] }) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-12" data-testid="home-hero">
      <div className="grid gap-6 lg:grid-cols-2">
        {hero ? <HeroLargeCard article={hero} /> : <div />}
        <div className="grid gap-6 sm:grid-cols-2">
          {side.slice(0, 4).map((p) => (
            <HeroSideCard key={p.id} article={p} />
          ))}
        </div>
      </div>

      <form
        action="/articles"
        className="mt-8 flex items-center gap-3 rounded-xl border-2 border-forest-600/70 bg-paper px-5 py-3"
        data-testid="hero-search"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 shrink-0 text-forest-600"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="search"
          name="q"
          placeholder="Where do you want to go?"
          className="flex-1 bg-transparent text-base text-forest-900 outline-none placeholder:text-forest-900/50"
        />
        <button
          type="submit"
          className="font-urbanist shrink-0 text-sm font-bold uppercase tracking-wider text-forest-700 transition hover:text-forest-600"
        >
          Find Travel Inspiration
        </button>
      </form>
    </section>
  );
}

function CategoryLabel({ article, light = false }: { article: StrapiArticle; light?: boolean }) {
  const chips: string[] = [];
  if (article.category) chips.push(article.category.name);
  (article.destinations ?? []).forEach((d) => {
    if (!chips.includes(d.name)) chips.push(d.name);
  });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {chips.slice(0, 4).map((name) => (
        <span
          key={name}
          className={`font-urbanist inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider ${light ? 'text-white' : 'text-primary-emphasis'}`}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-secondary-emphasis" />
          {name}
        </span>
      ))}
    </div>
  );
}

function HeroMeta({ article }: { article: StrapiArticle }) {
  return (
    <div className="mt-3 flex items-center gap-3 text-sm">
      {article.author?.name && (
        <span className="font-medium text-forest-900">{article.author.name}</span>
      )}
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-secondary-emphasis" />
      <span className="text-forest-900/70">{article.readingTimeMinutes ?? 5} min</span>
    </div>
  );
}

function HeroLargeCard({ article }: { article: StrapiArticle }) {
  const img = mediaUrl(article.coverImage ?? null);
  return (
    <Link
      href={`/articles/${article.slug}`}
      className="group flex flex-col"
      data-testid="hero-large"
    >
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={article.title}
          className="aspect-[4/3] w-full rounded-2xl object-cover transition duration-500 group-hover:scale-[1.01]"
        />
      ) : (
        <div className="aspect-[4/3] w-full rounded-2xl bg-forest-900/10" />
      )}
      <div className="mt-5">
        <CategoryLabel article={article} />
        <h1 className="font-urbanist mt-3 text-3xl font-bold leading-tight text-forest-900 transition group-hover:text-forest-700 sm:text-3xl">
          {article.title}
        </h1>
        <HeroMeta article={article} />
      </div>
    </Link>
  );
}

function HeroSideCard({ article }: { article: StrapiArticle }) {
  const img = mediaUrl(article.coverImage ?? null);
  return (
    <Link
      href={`/articles/${article.slug}`}
      className="group flex flex-col"
      data-testid="hero-side"
    >
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={article.title}
          className="aspect-[4/3] w-full rounded-2xl object-cover transition duration-500 group-hover:scale-[1.01]"
        />
      ) : (
        <div className="aspect-[4/3] w-full rounded-2xl bg-forest-900/10" />
      )}
      <div className="mt-4">
        <CategoryLabel article={article} />
        <h2 className="font-urbanist mt-2 line-clamp-2 text-lg font-bold leading-snug text-forest-900 transition group-hover:text-forest-700">
          {article.title}
        </h2>
        <HeroMeta article={article} />
      </div>
    </Link>
  );
}

type Section = (typeof SECTIONS)[number];

function EmptySection({ section }: { section: Section }) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-16" data-testid={`section-${section.slug}-empty`}>
      <EditorialSectionHeader section={section} />
      <div className="mt-8 rounded-3xl border border-dashed border-forest-900/15 p-12 text-center">
        <p className="font-light text-forest-900/60">No stories in {section.title} yet — publish your first one in the CMS.</p>
      </div>
    </section>
  );
}

/* ---------- Editorial section — feature + stacked list ---------- */

function EditorialSection({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  const [feature, ...rest] = posts;
  const list = rest.slice(0, 4);
  // Hotels section flips the layout: compact list on the LEFT, feature image on the RIGHT.
  const reverse = section.slug === 'hotels';
  const gridCols = reverse
    ? 'lg:grid-cols-[minmax(360px,0.9fr)_minmax(0,1fr)]'
    : 'lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]';

  const featureEl = <FeatureArticle article={feature} />;
  const listEl = (
    <div className="divide-y divide-forest-900/12 border-y border-forest-900/12">
      {list.map((post) => (
        <CompactArticleRow key={post.id} article={post} />
      ))}
    </div>
  );

  return (
    <section
      className={section.slug === 'flights' ? 'bg-forest-50 py-20' : 'py-20'}
      data-testid={`section-${section.slug}`}
    >
      <div className="mx-auto max-w-7xl px-6">
        <EditorialSectionHeader section={section} />
        <div className={`mt-10 grid gap-8 ${gridCols} lg:gap-10`}>
          {reverse ? listEl : featureEl}
          {reverse ? featureEl : listEl}
        </div>
      </div>
    </section>
  );
}

function EditorialSectionHeader({ section }: { section: Section }) {
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-3xl">
        <h2 className="font-urbanist text-2xl font-bold leading-tight text-forest-900 sm:text-3xl">
          {section.title}
        </h2>
        <p className="mt-4 max-w-3xl text-sm leading-6 text-ink/75 sm:text-base">
          {section.description}
        </p>
      </div>
      <Link
        href={`/category/${section.slug}`}
        className="inline-flex w-fit items-center justify-center rounded-[0.3rem] border border-forest-900 px-4 py-2 font-urbanist text-xs font-bold uppercase tracking-wider text-forest-900 transition hover:bg-primary-emphasis hover:text-white"
        data-testid={`section-all-${section.slug}`}
      >
        See all
      </Link>
    </div>
  );
}

function FeatureArticle({ article }: { article: StrapiArticle }) {
  const img = mediaUrl(article.coverImage ?? null);
  return (
    <article className="group" data-testid={`feature-article-${article.slug}`}>
      <Link href={`/articles/${article.slug}`} className="block overflow-hidden rounded-[0.3rem] bg-forest-900/5">
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={article.coverImage?.alternativeText || article.title}
          className="aspect-[16/11] w-full object-cover transition duration-500 group-hover:scale-[1.02]"
        />
      ) : (
        <div className="aspect-[16/11] w-full bg-gradient-to-br from-primary-hover to-primary-pressed" />
      )}
      </Link>
      <div className="mt-5">
        <CategoryLabel article={article} />
        <Link href={`/articles/${article.slug}`}>
          <h3 className="font-urbanist mt-3 text-xl font-bold leading-tight text-forest-900 transition group-hover:text-primary-highlight sm:text-2xl">
            {article.title}
          </h3>
        </Link>
        {article.excerpt && (
          <p className="mt-3 line-clamp-2 max-w-2xl text-sm leading-6 text-ink/75 sm:text-base">
            {article.excerpt}
          </p>
        )}
        <ArticleMeta article={article} />
      </div>
    </article>
  );
}

function CompactArticleRow({ article }: { article: StrapiArticle }) {
  const img = mediaUrl(article.coverImage ?? null);
  return (
    <article className="group py-6" data-testid={`compact-article-${article.slug}`}>
      <Link href={`/articles/${article.slug}`} className="grid grid-cols-[92px_minmax(0,1fr)] gap-5 sm:grid-cols-[112px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-[0.3rem] bg-forest-900/5">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={img}
              alt={article.coverImage?.alternativeText || article.title}
              className="aspect-square h-full w-full object-cover transition duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="aspect-square bg-gradient-to-br from-primary-hover to-primary-pressed" />
          )}
        </div>
        <div className="min-w-0">
          <CategoryLabel article={article} />
          <h3 className="mt-2 line-clamp-2 font-urbanist text-base font-bold leading-snug text-forest-900 transition group-hover:text-primary-highlight sm:text-lg">
            {article.title}
          </h3>
          <ArticleMeta article={article} compact />
        </div>
      </Link>
    </article>
  );
}

function ArticleMeta({ article, compact = false }: { article: StrapiArticle; compact?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 text-sm text-forest-900/75 ${compact ? 'mt-3' : 'mt-4'}`}>
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary-emphasis font-urbanist text-sm font-bold text-primary-emphasis">
        {(article.author?.name || 'O').slice(0, 1).toUpperCase()}
      </span>
      {article.author?.name && <span>{article.author.name}</span>}
      {article.author?.name && <span className="text-forest-900/35">|</span>}
      <span>{article.readingTimeMinutes ?? 5} min read</span>
    </div>
  );
}
