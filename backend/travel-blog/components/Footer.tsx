import Link from 'next/link';
import Image from 'next/image';
import { SECTIONS } from '@/lib/sections';
import { getLegalDoc } from '@/lib/legal';

const BOTTOM_BAR_SLUGS = ['privacy', 'terms', 'cookies', 'disclaimer', 'accessibility', 'contact'];

export default function Footer() {
  const year = new Date().getFullYear();
  const bottomLegal = BOTTOM_BAR_SLUGS
    .map((slug) => getLegalDoc(slug))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  return (
    <footer className="mt-24 border-t border-primary-emphasis/10 bg-forest-950 text-white" data-testid="site-footer">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-16 md:grid-cols-[11fr_3fr_3fr_3fr]">
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
            The facts behind every place worth visiting — plus the latest on flights, hotels, airlines, airports and destinations.
          </p>
          <ul className="mt-5 flex items-center gap-3" data-testid="footer-social">
            <li>
              <a
                href="https://x.com/realoriginfacts"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Originfacts on X"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white transition hover:border-secondary-emphasis hover:text-secondary-emphasis"
                data-testid="footer-social-x"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.967 6.817H1.677l7.73-8.835L1.255 2.25h6.83l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
            </li>
            <li>
              <a
                href="https://www.facebook.com/originfacts/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Originfacts on Facebook"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white transition hover:border-secondary-emphasis hover:text-secondary-emphasis"
                data-testid="footer-social-facebook"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <path d="M22 12.06C22 6.48 17.52 2 11.94 2 6.36 2 1.88 6.48 1.88 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.78v-2.91h2.54V9.84c0-2.51 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46H15.1c-1.24 0-1.62.77-1.62 1.56v1.87h2.76l-.44 2.91h-2.32V22c4.78-.76 8.52-4.92 8.52-9.94z" />
                </svg>
              </a>
            </li>
          </ul>
        </div>
        <div>
          <h4 className="editorial-h text-lg capitalize tracking-normal text-secondary-emphasis">Topics</h4>
          <ul className="mt-3 space-y-2 text-sm text-white/80" data-testid="footer-topics">
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
          <h4 className="editorial-h text-lg capitalize tracking-normal text-secondary-emphasis">Discover</h4>
          <ul className="mt-3 space-y-2 text-sm text-white/80" data-testid="footer-travel-index">
            <li><Link href="/flights" className="hover:text-secondary">Flights</Link></li>
            <li><Link href="/hotels" className="hover:text-secondary">Hotels</Link></li>
            <li><Link href="/countries" className="hover:text-secondary">Countries</Link></li>
            <li><Link href="/airlines" className="hover:text-secondary">Airlines</Link></li>
            <li><Link href="/airports" className="hover:text-secondary">Airports</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="editorial-h text-lg capitalize tracking-normal text-secondary-emphasis">Company</h4>
          <ul className="mt-3 space-y-2 text-sm text-white/80" data-testid="footer-company">
            <li><Link href="/" className="hover:text-secondary">Home</Link></li>
            <li><Link href="/about" className="hover:text-secondary">About</Link></li>
            <li><Link href="/contact" className="hover:text-secondary">Contact</Link></li>
            <li><Link href="/legal/affiliate-disclosure" className="hover:text-secondary">Affiliate Disclosure</Link></li>
            <li><Link href="/sitemap.xml" className="hover:text-secondary">Site Map</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-xs text-white/55 sm:flex-row sm:items-center sm:justify-between">
          <div>
            © {year} Originfacts. All rights reserved.
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
