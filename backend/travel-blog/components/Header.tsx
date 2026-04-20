import Link from 'next/link';
import { listCategories } from '@/lib/strapi';

export default async function Header() {
  let cats: Awaited<ReturnType<typeof listCategories>> = [];
  try { cats = await listCategories(); } catch { /* Strapi down — render without nav */ }

  return (
    <header className="border-b border-forest-900/10 bg-paper/80 backdrop-blur" data-testid="site-header">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-baseline gap-2" data-testid="logo-link">
          <span className="editorial-h text-2xl font-black text-forest-900">FXN</span>
          <span className="editorial-h text-xl font-light italic text-forest-800">Studio</span>
        </Link>
        <nav className="hidden gap-7 text-sm font-medium md:flex" data-testid="primary-nav">
          {cats.slice(0, 5).map((c) => (
            <Link
              key={c.id}
              href={`/category/${c.slug}`}
              className="text-forest-800 transition-colors hover:text-terracotta-700"
              data-testid={`nav-category-${c.slug}`}
            >
              {c.name}
            </Link>
          ))}
          <Link href="/destinations" className="text-forest-800 hover:text-terracotta-700" data-testid="nav-destinations">
            Destinations
          </Link>
          <Link href="/articles" className="text-forest-800 hover:text-terracotta-700" data-testid="nav-articles">
            All stories
          </Link>
        </nav>
      </div>
    </header>
  );
}
