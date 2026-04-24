import Link from 'next/link';
import { format } from 'date-fns';
import { mediaUrl, type StrapiArticle } from '@/lib/strapi';

export default function ArticleCard({ article, size = 'md' }: { article: StrapiArticle; size?: 'compact' | 'sm' | 'md' | 'lg' }) {
  const img = mediaUrl(article.coverImage ?? null);
  const date = article.publishedAt ? format(new Date(article.publishedAt), 'd MMM yyyy') : '';

  const sizeClasses = {
    compact: { img: 'aspect-[4/3]', title: 'text-base', excerpt: 'line-clamp-2 text-sm', radius: 'rounded-lg' },
    sm: { img: 'aspect-[4/3]', title: 'text-lg', excerpt: 'line-clamp-2 text-sm', radius: 'rounded-2xl' },
    md: { img: 'aspect-[5/4]', title: 'text-2xl', excerpt: 'line-clamp-3 text-base', radius: 'rounded-2xl' },
    lg: { img: 'aspect-[16/10]', title: 'text-2xl sm:text-3xl', excerpt: 'line-clamp-4 text-base sm:text-lg', radius: 'rounded-2xl' },
  }[size];

  return (
    <article className="group flex flex-col" data-testid={`article-card-${article.slug}`}>
      <Link href={`/articles/${article.slug}`} className={`block overflow-hidden ${sizeClasses.radius} bg-forest-900/5`}>
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={article.coverImage?.alternativeText || article.title}
            className={`${sizeClasses.img} w-full object-cover transition-transform duration-500 group-hover:scale-105`}
            loading="lazy"
          />
        ) : (
          <div className={`${sizeClasses.img} w-full bg-gradient-to-br from-forest-800 to-forest-950`} />
        )}
      </Link>
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-forest-800/70">
          {article.category && (
            <Link href={`/category/${article.category.slug}`} className="chip hover:bg-primary-pressed">
              {article.category.name}
            </Link>
          )}
          {date && <time dateTime={article.publishedAt}>{date}</time>}
          {article.readingTimeMinutes ? <span>· {article.readingTimeMinutes} min read</span> : null}
        </div>
        <Link href={`/articles/${article.slug}`}>
          <h3 className={`editorial-h font-bold leading-tight text-forest-900 transition-colors group-hover:text-primary-highlight ${sizeClasses.title}`}>
            {article.title}
          </h3>
        </Link>
        {article.excerpt && <p className={`${sizeClasses.excerpt} text-ink/70`}>{article.excerpt}</p>}
        {article.author && (
          <div className="mt-1 text-sm text-forest-800/70">by {article.author.name}</div>
        )}
      </div>
    </article>
  );
}
