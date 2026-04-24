import Link from 'next/link';
import { SECTIONS } from '@/lib/sections';

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-24 border-t border-primary-emphasis/10 bg-primary-emphasis text-white" data-testid="site-footer">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-16 md:grid-cols-3">
        <div>
          <div className="editorial-h text-3xl font-bold">Originfacts</div>
          <p className="mt-3 max-w-sm text-white/75">
            Travel writing without the fluff. Real itineraries, cheap flight tactics, hotels we'd actually book twice.
          </p>
        </div>
        <div>
          <h4 className="editorial-h text-sm uppercase tracking-widest text-secondary-emphasis">Categories</h4>
          <ul className="mt-3 space-y-2 text-white/80" data-testid="footer-categories">
            <li><Link href="/articles" className="hover:text-secondary">All stories</Link></li>
            {SECTIONS.map((section) => (
              <li key={section.slug}>
                <Link href={`/category/${section.slug}`} className="hover:text-secondary">
                  {section.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="editorial-h text-sm uppercase tracking-widest text-secondary-emphasis">Newsletter</h4>
          <p className="mt-3 text-white/75">One email a week. Deals, guides, zero spam.</p>
          <form className="mt-4 flex gap-2" data-testid="newsletter-form">
            <input
              type="email"
              required
              placeholder="you@roam.com"
              className="w-full rounded-full border border-white/30 bg-transparent px-4 py-2 text-sm placeholder:text-white/45 focus:border-secondary-emphasis focus:outline-none"
              data-testid="newsletter-email"
            />
            <button
              type="submit"
              className="rounded-full bg-secondary-emphasis px-4 py-2 text-sm font-medium text-ink hover:bg-secondary-hover"
              data-testid="newsletter-submit"
            >
              Join
            </button>
          </form>
        </div>
      </div>
      <div className="border-t border-white/10 py-6 text-center text-xs text-white/55">
        © {year} Originfacts · Built with Next.js & Strapi
      </div>
    </footer>
  );
}
