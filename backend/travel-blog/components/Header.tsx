import Link from 'next/link';
import Image from 'next/image';

export default function Header() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-primary-emphasis/10 bg-paper/90 backdrop-blur"
      data-testid="site-header"
    >
      <div className="mx-auto flex max-w-[1500px] items-center gap-6 px-6 py-5">
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

        <form
          action="/articles"
          method="get"
          role="search"
          className="hidden md:flex h-10 w-full max-w-md flex-1 items-center gap-2 rounded-full border border-forest-900/15 bg-white px-4 transition focus-within:border-primary-emphasis"
          data-testid="header-search"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-forest-900/50"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <label htmlFor="header-search-input" className="sr-only">Search stories</label>
          <input
            id="header-search-input"
            type="search"
            name="q"
            placeholder="Search stories…"
            className="h-full w-full bg-transparent text-sm text-forest-900 outline-none placeholder:text-forest-900/45"
            data-testid="header-search-input"
          />
        </form>

        <div className="ml-auto flex items-center justify-end gap-2">
          <nav className="hidden md:block" data-testid="primary-nav">
            <ul className="flex items-center justify-end gap-1 text-base font-medium">
              <li data-testid="nav-item-destinations">
                <Link
                  href="/destinations"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-[#000000] transition-colors hover:text-[rgb(1,79,211)]"
                  data-testid="nav-destinations"
                >
                  Destinations
                </Link>
              </li>
              <li data-testid="nav-item-flights">
                <Link
                  href="/flights"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-[#000000] transition-colors hover:text-[rgb(1,79,211)]"
                  data-testid="nav-flights"
                >
                  Flights
                </Link>
              </li>
              <li data-testid="nav-item-hotels">
                <Link
                  href="/hotels"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-[#000000] transition-colors hover:text-[rgb(1,79,211)]"
                  data-testid="nav-hotels"
                >
                  Hotels
                </Link>
              </li>
              <li data-testid="nav-item-airlines">
                <Link
                  href="/airlines"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-[#000000] transition-colors hover:text-[rgb(1,79,211)]"
                  data-testid="nav-airlines"
                >
                  Airlines
                </Link>
              </li>
              <li
                className="group/airports relative"
                data-testid="nav-item-airports"
              >
                <Link
                  href="/airports"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-[#000000] transition-colors hover:text-[rgb(1,79,211)]"
                  data-testid="nav-airports"
                  aria-haspopup="true"
                >
                  Airports
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3 w-3 opacity-60"
                    aria-hidden
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </Link>
                <div
                  className="invisible absolute left-0 top-full z-10 mt-1 min-w-[220px] rounded-md border border-forest-900/10 bg-paper p-1 opacity-0 shadow-md transition duration-150 group-hover/airports:visible group-hover/airports:opacity-100 group-focus-within/airports:visible group-focus-within/airports:opacity-100"
                  role="menu"
                  data-testid="nav-airports-dropdown"
                >
                  <Link
                    href="/airports"
                    className="block rounded px-3 py-2 text-base text-[#000000] transition-colors hover:bg-forest-900/5 hover:text-[rgb(1,79,211)]"
                    role="menuitem"
                    data-testid="nav-airports-all"
                  >
                    All airports
                  </Link>
                  <Link
                    href="/airports/hubs"
                    className="block rounded px-3 py-2 text-base text-[#000000] transition-colors hover:bg-forest-900/5 hover:text-[rgb(1,79,211)]"
                    role="menuitem"
                    data-testid="nav-airports-hubs"
                  >
                    Top international hubs
                  </Link>
                </div>
              </li>
              <li data-testid="nav-item-countries">
                <Link
                  href="/countries"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-[#000000] transition-colors hover:text-[rgb(1,79,211)]"
                  data-testid="nav-countries"
                >
                  Countries
                </Link>
              </li>
            </ul>
          </nav>

        </div>
      </div>
    </header>
  );
}
