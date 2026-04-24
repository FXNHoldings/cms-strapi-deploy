import Link from 'next/link';
import Image from 'next/image';

export default function Header() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-primary-emphasis/10 bg-paper/90 backdrop-blur"
      data-testid="site-header"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="block shrink-0" data-testid="logo-link" aria-label="Originfacts home">
          <Image
            src="/brand/logo/logo.svg"
            alt="Originfacts"
            width={300}
            height={167}
            priority
            className="h-12 w-auto sm:h-14"
          />
        </Link>

        <div className="ml-auto flex items-center justify-end gap-2">
          <nav className="hidden md:block" data-testid="primary-nav">
            <ul className="flex items-center justify-end gap-1 text-sm font-medium">
              <li data-testid="nav-item-destinations">
                <Link
                  href="/destinations"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-primary-emphasis transition-colors hover:text-primary-highlight"
                  data-testid="nav-destinations"
                >
                  Destinations
                </Link>
              </li>
              <li data-testid="nav-item-flights">
                <Link
                  href="/flights"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-primary-emphasis transition-colors hover:text-primary-highlight"
                  data-testid="nav-flights"
                >
                  Flights
                </Link>
              </li>
              <li data-testid="nav-item-airlines">
                <Link
                  href="/airlines"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-primary-emphasis transition-colors hover:text-primary-highlight"
                  data-testid="nav-airlines"
                >
                  Airlines
                </Link>
              </li>
              <li data-testid="nav-item-airports">
                <Link
                  href="/airports"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-primary-emphasis transition-colors hover:text-primary-highlight"
                  data-testid="nav-airports"
                >
                  Airports
                </Link>
              </li>
              <li data-testid="nav-item-countries">
                <Link
                  href="/countries"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-primary-emphasis transition-colors hover:text-primary-highlight"
                  data-testid="nav-countries"
                >
                  Countries
                </Link>
              </li>
            </ul>
          </nav>

          <Link
            href="/articles"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-primary-emphasis transition hover:bg-primary-hover hover:text-primary-highlight"
            aria-label="Search stories"
            title="Search stories"
            data-testid="nav-search"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </Link>
        </div>
      </div>
    </header>
  );
}
