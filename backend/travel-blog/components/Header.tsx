import Link from 'next/link';

export default function Header() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-forest-900/10 bg-paper/85 backdrop-blur"
      data-testid="site-header"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-baseline gap-2" data-testid="logo-link">
          <span className="font-urbanist text-2xl font-black text-forest-900">Originfacts</span>
        </Link>

        <nav className="hidden md:block" data-testid="primary-nav">
          <ul className="flex items-center gap-1 text-sm font-medium">
            <li data-testid="nav-item-destinations">
              <Link
                href="/destinations"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-forest-800 transition-colors hover:text-terracotta-700"
                data-testid="nav-destinations"
              >
                Destinations
              </Link>
            </li>
            <li data-testid="nav-item-flights">
              <Link
                href="/flights"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-forest-800 transition-colors hover:text-terracotta-700"
                data-testid="nav-flights"
              >
                Flights
              </Link>
            </li>
            <li data-testid="nav-item-airlines">
              <Link
                href="/airlines"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-forest-800 transition-colors hover:text-terracotta-700"
                data-testid="nav-airlines"
              >
                Airlines
              </Link>
            </li>
            <li data-testid="nav-item-airports">
              <Link
                href="/airports"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-forest-800 transition-colors hover:text-terracotta-700"
                data-testid="nav-airports"
              >
                Airports
              </Link>
            </li>
            <li data-testid="nav-item-countries">
              <Link
                href="/countries"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-forest-800 transition-colors hover:text-terracotta-700"
                data-testid="nav-countries"
              >
                Countries
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
