import Link from 'next/link';
import { listArticles, listCategories, mediaUrl, type StrapiArticle } from '@/lib/strapi';
import { SECTIONS } from '@/lib/sections';

export const revalidate = 60;

export default async function HomePage() {
  const [categories, ...perSection] = await Promise.all([
    listCategories().catch(() => []),
    ...SECTIONS.map((s) => listArticles({ category: s.slug, pageSize: 10 }).then((r) => r.data).catch(() => [])),
  ]);

  const bySection = Object.fromEntries(SECTIONS.map((s, i) => [s.slug, perSection[i] as StrapiArticle[]]));

  // Hero: latest across all categories (falls back if first section is empty)
  const hero: StrapiArticle | undefined = perSection.flat().sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  )[0];

  return (
    <div data-testid="home-page">
      <Hero hero={hero} categories={categories} />

      {SECTIONS.map((s) => {
        const posts = bySection[s.slug] ?? [];
        if (posts.length === 0) return <EmptySection key={s.slug} section={s} />;
        return <Section key={s.slug} section={s} posts={posts} />;
      })}
    </div>
  );
}

/* ---------- HERO ---------- */

function Hero({ hero, categories }: { hero?: StrapiArticle; categories: Awaited<ReturnType<typeof listCategories>> }) {
  const img = hero ? mediaUrl(hero.coverImage ?? null) : null;
  return (
    <section className="relative overflow-hidden border-b border-forest-900/10 bg-forest-950" data-testid="home-hero">
      {img && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover opacity-30" />
      )}
      <div className="absolute inset-0 bg-gradient-to-br from-forest-950/85 via-forest-900/60 to-forest-950/95" />
      <div className="relative mx-auto flex min-h-[72vh] max-w-7xl flex-col justify-end px-6 pb-16 pt-24 text-sand-100">
        <p className="font-urbanist text-xs uppercase tracking-[0.3em] text-sand-200" data-testid="hero-eyebrow">
          FXN Studio · Since 2026
        </p>
        <h1 className="font-urbanist mt-6 text-5xl font-bold leading-[0.95] lg:text-8xl" data-testid="hero-title">
          Go further.<br />
          <span className="font-light italic text-sand-200">Pay less.</span> Stay longer.
        </h1>
        <p className="mt-6 max-w-xl text-lg font-light text-sand-100/80 lg:text-xl">
          Hand-picked travel writing for people who'd rather spend on the trip than on the booking.
        </p>
        {hero && (
          <Link
            href={`/articles/${hero.slug}`}
            className="group mt-10 flex max-w-2xl items-center gap-6 border-t border-sand-100/20 pt-6 text-left"
            data-testid="hero-link"
          >
            <div className="font-urbanist text-xs uppercase tracking-[0.25em] text-sand-200/70">Reading now</div>
            <div className="flex-1">
              <div className="font-urbanist text-xl font-bold leading-tight transition group-hover:text-sand-200 lg:text-2xl">
                {hero.title}
              </div>
              {hero.excerpt && <div className="mt-1 line-clamp-1 text-sm font-light opacity-80">{hero.excerpt}</div>}
            </div>
            <span className="font-urbanist text-2xl transition group-hover:translate-x-1">→</span>
          </Link>
        )}
        {categories.length > 0 && (
          <div className="mt-10 flex flex-wrap gap-2" data-testid="hero-categories">
            {categories.slice(0, 8).map((c) => (
              <Link
                key={c.id}
                href={`/category/${c.slug}`}
                className="rounded-full border border-sand-100/25 px-4 py-1.5 text-sm font-light text-sand-100 transition hover:bg-sand-100 hover:text-forest-950"
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- SECTION DISPATCHER ---------- */

type Section = (typeof SECTIONS)[number];

function Section({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  switch (section.layout) {
    case 'atlas': return <AtlasLayout section={section} posts={posts} />;
    case 'departure': return <DepartureLayout section={section} posts={posts} />;
    case 'wirecutter': return <WirecutterLayout section={section} posts={posts} />;
    case 'directory': return <DirectoryLayout section={section} posts={posts} />;
    case 'masonry': return <MasonryLayout section={section} posts={posts} />;
    case 'grid': return <GridLayout section={section} posts={posts} />;
    default: return null;
  }
}

function EmptySection({ section }: { section: Section }) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-16" data-testid={`section-${section.slug}-empty`}>
      <SectionHeader section={section} />
      <div className="mt-8 rounded-3xl border border-dashed border-forest-900/15 p-12 text-center">
        <p className="font-light text-forest-900/60">No stories in {section.title} yet — publish your first one in the CMS.</p>
      </div>
    </section>
  );
}

function SectionHeader({ section, light = false }: { section: Section; light?: boolean }) {
  return (
    <div className="flex items-end justify-between gap-6" data-testid={`section-header-${section.slug}`}>
      <div>
        <p className={`section-eyebrow ${light ? 'text-sand-200/80' : ''}`}>
          <span className={`inline-block h-px w-8 ${light ? 'bg-sand-200/60' : 'bg-forest-800/60'}`} />
          {section.tagline}
        </p>
        <h2 className={`font-urbanist mt-3 text-4xl font-bold tracking-tightest lg:text-6xl ${light ? 'text-sand-100' : 'text-forest-900'}`}>
          {section.title}
        </h2>
      </div>
      <Link
        href={`/category/${section.slug}`}
        className={`hidden shrink-0 rounded-full border px-5 py-2 text-sm font-medium transition md:inline-flex ${light ? 'border-sand-100/30 text-sand-100 hover:bg-sand-100 hover:text-forest-950' : 'border-forest-900/20 text-forest-900 hover:bg-forest-900 hover:text-sand-100'}`}
        data-testid={`section-all-${section.slug}`}
      >
        All {section.title.toLowerCase()} →
      </Link>
    </div>
  );
}

/* ---------- LAYOUT 1 · DESTINATIONS — Atlas (compact grid of small cards) ---------- */

function AtlasLayout({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20" data-testid={`section-${section.slug}`}>
      <SectionHeader section={section} />
      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {posts.slice(0, 8).map((p) => <SmallCard key={p.id} post={p} />)}
      </div>
    </section>
  );
}

/* ---------- LAYOUT 2 · FLIGHTS — Departure board (dark strip + horizontal scroll) ---------- */

function DepartureLayout({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  return (
    <section className="bg-forest-950 py-24 text-sand-100" data-testid={`section-${section.slug}`}>
      <div className="mx-auto max-w-7xl px-6">
        <SectionHeader section={section} light />
        <div className="mt-10 flex snap-x gap-5 overflow-x-auto pb-6">
          {posts.map((p, i) => {
            const img = mediaUrl(p.coverImage ?? null);
            const code = (p.destinations?.[0]?.name || p.title).slice(0, 3).toUpperCase();
            return (
              <Link
                key={p.id}
                href={`/articles/${p.slug}`}
                className="group relative flex w-80 flex-none snap-start flex-col overflow-hidden rounded-xl bg-forest-900 ring-1 ring-sand-100/10 transition hover:ring-sand-200/40"
              >
                <div className="flex items-center justify-between border-b border-dashed border-sand-100/20 px-5 py-3 font-urbanist text-xs uppercase tracking-[0.25em] text-sand-200/80">
                  <span>Gate {String(i + 1).padStart(2, '0')}</span>
                  <span className="tabular-nums">{code}</span>
                </div>
                {img && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img} alt={p.title} className="h-44 w-full object-cover opacity-85 transition group-hover:opacity-100" />
                )}
                <div className="flex flex-1 flex-col p-5">
                  <div className="font-urbanist text-lg font-bold leading-tight">{p.title}</div>
                  {p.excerpt && <p className="mt-2 line-clamp-2 text-sm font-light opacity-80">{p.excerpt}</p>}
                  <div className="mt-auto flex items-center justify-between pt-4 font-urbanist text-xs uppercase tracking-widest opacity-70">
                    <span>{p.readingTimeMinutes ?? 5} min</span>
                    <span className="transition group-hover:translate-x-1">Board →</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------- LAYOUT 3 · HOTELS — Wirecutter (numbered picks with thumbnails) ---------- */

function WirecutterLayout({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  return (
    <section className="bg-paper py-20" data-testid={`section-${section.slug}`}>
      <div className="mx-auto max-w-5xl px-6">
        <SectionHeader section={section} />
        <ol className="mt-10 divide-y divide-forest-900/10 border-y border-forest-900/10">
          {posts.slice(0, 8).map((p, i) => {
            const img = mediaUrl(p.coverImage ?? null);
            return (
              <li key={p.id}>
                <Link
                  href={`/articles/${p.slug}`}
                  className="group grid grid-cols-[auto,88px,1fr] items-center gap-5 py-5 transition hover:bg-sand-50 sm:grid-cols-[auto,120px,1fr,auto] sm:gap-6"
                >
                  <span className="font-urbanist text-2xl font-bold tabular-nums text-terracotta-600 sm:text-3xl">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img}
                      alt={p.title}
                      className="aspect-[4/3] w-[88px] rounded-lg object-cover sm:w-[120px]"
                    />
                  ) : (
                    <div className="aspect-[4/3] w-[88px] rounded-lg bg-forest-900/10 sm:w-[120px]" />
                  )}
                  <div className="min-w-0">
                    <h3 className="font-urbanist text-base font-bold leading-snug text-forest-900 transition group-hover:text-terracotta-700 sm:text-lg">
                      {p.title}
                    </h3>
                    {p.excerpt && (
                      <p className="mt-1 line-clamp-2 text-sm font-light text-ink/70">{p.excerpt}</p>
                    )}
                  </div>
                  <div className="font-urbanist hidden text-right text-xs uppercase tracking-widest text-forest-800/60 sm:block">
                    {p.readingTimeMinutes ?? 5} min
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/* ---------- LAYOUT 4 · TRAVEL RESOURCES — Numbered directory (no images in list) ---------- */

function DirectoryLayout({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  return (
    <section className="bg-sand-50 py-24" data-testid={`section-${section.slug}`}>
      <div className="mx-auto max-w-5xl px-6">
        <SectionHeader section={section} />
        <ul className="mt-12 divide-y divide-forest-900/10 border-y border-forest-900/10">
          {posts.slice(0, 8).map((p, i) => (
            <li key={p.id}>
              <Link
                href={`/articles/${p.slug}`}
                className="group grid grid-cols-12 items-baseline gap-6 py-6 transition hover:bg-paper/60"
              >
                <span className="font-urbanist col-span-2 text-3xl font-bold tabular-nums text-terracotta-600 lg:text-4xl">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="col-span-10 lg:col-span-7">
                  <h3 className="font-urbanist text-xl font-bold leading-tight text-forest-900 transition group-hover:text-terracotta-700 lg:text-2xl">
                    {p.title}
                  </h3>
                  {p.excerpt && <p className="mt-1 line-clamp-2 text-sm font-light text-ink/70">{p.excerpt}</p>}
                </div>
                <div className="col-span-12 flex items-center justify-between text-xs font-light text-forest-800/70 lg:col-span-3 lg:flex-col lg:items-end lg:gap-1 lg:text-right">
                  {p.category && <span className="chip">{p.category.name}</span>}
                  <span className="tabular-nums">{p.readingTimeMinutes ?? 5} min read</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- LAYOUT 5 · TRAVEL TIPS — Broken masonry with pull-quote ---------- */

function MasonryLayout({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24" data-testid={`section-${section.slug}`}>
      <SectionHeader section={section} />
      <div className="mt-12 columns-1 gap-6 md:columns-2 lg:columns-3 [column-fill:_balance]">
        {posts.slice(0, 8).map((p, i) => {
          const img = mediaUrl(p.coverImage ?? null);
          // Mix of aspect ratios for variety
          const aspect = ['aspect-[4/5]', 'aspect-[3/4]', 'aspect-[1/1]', 'aspect-[4/5]', 'aspect-[16/11]', 'aspect-[3/4]'][i % 6];
          return (
            <Link
              key={p.id}
              href={`/articles/${p.slug}`}
              className="mb-6 block break-inside-avoid overflow-hidden rounded-2xl bg-forest-900/5 transition hover:bg-forest-900/10"
            >
              {img && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img} alt={p.title} className={`${aspect} w-full object-cover`} />
              )}
              <div className="p-5">
                {p.category && <span className="chip">{p.category.name}</span>}
                <h3 className="font-urbanist mt-3 text-xl font-bold leading-tight text-forest-900">{p.title}</h3>
                {p.excerpt && <p className="mt-2 line-clamp-3 text-sm font-light text-ink/70">{p.excerpt}</p>}
              </div>
            </Link>
          );
        })}
        {/* A pull-quote callout in the flow */}
        <div className="mb-6 break-inside-avoid rounded-2xl bg-forest-900 p-8 text-sand-100">
          <div className="font-urbanist text-xs uppercase tracking-[0.3em] text-sand-200/70">Pro tip</div>
          <p className="font-urbanist mt-4 text-2xl font-bold italic leading-tight lg:text-3xl">
            "Book the flight on a Thursday. Fly on a Tuesday. Thank us later."
          </p>
          <Link
            href={`/category/${section.slug}`}
            className="font-urbanist mt-6 inline-flex text-xs uppercase tracking-widest text-sand-200 underline-offset-4 hover:underline"
          >
            More travel tips →
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ---------- LAYOUT 6 · CAR RENTAL — Grid (clean, compact 4-col) ---------- */

function GridLayout({ section, posts }: { section: Section; posts: StrapiArticle[] }) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-20" data-testid={`section-${section.slug}`}>
      <SectionHeader section={section} />
      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {posts.slice(0, 8).map((p) => <SmallCard key={p.id} post={p} />)}
      </div>
    </section>
  );
}

/* ---------- Reusable small card (Atlas + Grid) ---------- */

function SmallCard({ post }: { post: StrapiArticle }) {
  const img = mediaUrl(post.coverImage ?? null);
  return (
    <Link
      href={`/articles/${post.slug}`}
      className="group block overflow-hidden rounded-2xl bg-forest-900/5 transition hover:bg-forest-900/10"
    >
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={post.title}
          className="aspect-[4/3] w-full object-cover transition duration-500 group-hover:scale-105"
        />
      ) : (
        <div className="aspect-[4/3] w-full bg-gradient-to-br from-forest-900/10 to-forest-900/20" />
      )}
      <div className="p-4">
        {post.category && <span className="chip text-[10px]">{post.category.name}</span>}
        <h3 className="font-urbanist mt-2 line-clamp-2 text-base font-bold leading-snug text-forest-900 transition group-hover:text-terracotta-700">
          {post.title}
        </h3>
        <div className="font-urbanist mt-2 text-xs uppercase tracking-widest text-forest-800/60">
          {post.readingTimeMinutes ?? 5} min read
        </div>
      </div>
    </Link>
  );
}
