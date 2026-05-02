import Link from 'next/link';
import Image from 'next/image';
import { SECTIONS } from '@/lib/sections';
import { LEGAL_DOCS } from '@/lib/legal';

const BOTTOM_BAR_SLUGS = new Set(['contact', 'accessibility']);

export default function Footer() {
  const year = new Date().getFullYear();
  const mainLegal = LEGAL_DOCS.filter((d) => !BOTTOM_BAR_SLUGS.has(d.slug));
  const bottomLegal = LEGAL_DOCS.filter((d) => BOTTOM_BAR_SLUGS.has(d.slug));

  return (
    <footer className="mt-24 border-t border-primary-emphasis/10 bg-forest-950 text-white" data-testid="site-footer">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-16 md:grid-cols-4">
        <div>
          <Link href="/" aria-label="Originfacts home" className="inline-block" data-testid="footer-logo-link">
            <Image
              src="/footer-logo.svg"
              alt="Originfacts"
              width={300}
              height={167}
              className="h-10 w-auto !rounded-none"
            />
          </Link>
          <p className="mt-3 max-w-sm text-white/75">
            Travel writing without the fluff. Real itineraries, cheap flight tactics, hotels we'd actually book twice.
          </p>
          <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/80" data-testid="footer-company">
            <li>
              <Link href="/about" className="hover:text-secondary">About</Link>
            </li>
            <li>
              <Link href="/contact" className="hover:text-secondary">Contact</Link>
            </li>
          </ul>
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
          <h4 className="editorial-h text-sm uppercase tracking-widest text-secondary-emphasis">Legal</h4>
          <ul className="mt-3 space-y-2 text-white/80" data-testid="footer-legal">
            {mainLegal.map((doc) => (
              <li key={doc.slug}>
                <Link href={`/legal/${doc.slug}`} className="hover:text-secondary">
                  {doc.title}
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
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-xs text-white/55 sm:flex-row sm:items-center sm:justify-between">
          <div>
            © {year} Originfacts · FXN Holdings Limited · Registered in England and Wales · Company no. 16134139
          </div>
          <nav aria-label="Legal" data-testid="footer-bottom-legal">
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {bottomLegal.map((doc) => (
                <li key={doc.slug}>
                  <Link href={`/legal/${doc.slug}`} className="hover:text-secondary">
                    {doc.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
