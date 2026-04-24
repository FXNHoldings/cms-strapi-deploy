import Link from 'next/link';
import { SECTIONS } from '@/lib/sections';

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-24 border-t border-forest-900/10 bg-forest-900 text-sand-100" data-testid="site-footer">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-16 md:grid-cols-3">
        <div>
          <div className="editorial-h text-3xl font-black">Originfacts</div>
          <p className="mt-3 max-w-sm text-sand-100/70">
            Travel writing without the fluff. Real itineraries, cheap flight tactics, hotels we'd actually book twice.
          </p>
        </div>
        <div>
          <h4 className="editorial-h text-sm uppercase tracking-widest text-sand-200">Categories</h4>
          <ul className="mt-3 space-y-2 text-sand-100/80" data-testid="footer-categories">
            <li><Link href="/articles" className="hover:text-white">All stories</Link></li>
            {SECTIONS.map((section) => (
              <li key={section.slug}>
                <Link href={`/category/${section.slug}`} className="hover:text-white">
                  {section.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="editorial-h text-sm uppercase tracking-widest text-sand-200">Newsletter</h4>
          <p className="mt-3 text-sand-100/70">One email a week. Deals, guides, zero spam.</p>
          <form className="mt-4 flex gap-2" data-testid="newsletter-form">
            <input
              type="email"
              required
              placeholder="you@roam.com"
              className="w-full rounded-full border border-sand-100/30 bg-transparent px-4 py-2 text-sm placeholder:text-sand-100/40 focus:border-sand-300 focus:outline-none"
              data-testid="newsletter-email"
            />
            <button
              type="submit"
              className="rounded-full bg-sand-200 px-4 py-2 text-sm font-medium text-forest-900 hover:bg-sand-300"
              data-testid="newsletter-submit"
            >
              Join
            </button>
          </form>
        </div>
      </div>
      <div className="border-t border-sand-100/10 py-6 text-center text-xs text-sand-100/50">
        © {year} Originfacts · Built with Next.js & Strapi
      </div>
    </footer>
  );
}
