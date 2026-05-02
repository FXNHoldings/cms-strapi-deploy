'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { AirlineRegion } from '@/lib/strapi';

const REGION_ORDER: AirlineRegion[] = ['Africa', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];
const PER_REGION_LIMIT = 24;

export type CountryRow = {
  code: string;
  name: string;
  region: AirlineRegion | null;
  airportCount: number;
  cityCount: number;
};

function flagEmoji(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const cc = code.toUpperCase();
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export default function CountriesDirectory({ countries }: { countries: CountryRow[] }) {
  const [query, setQuery] = useState('');
  const [activeRegion, setActiveRegion] = useState<AirlineRegion | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return countries.filter((c) => {
      if (activeRegion && c.region !== activeRegion) return false;
      if (!q) return true;
      return (c.name + ' ' + c.code).toLowerCase().includes(q);
    });
  }, [countries, query, activeRegion]);

  const byRegion = useMemo(() => {
    const map = new Map<AirlineRegion, CountryRow[]>();
    for (const c of filtered) {
      const r = (c.region || 'Asia') as AirlineRegion;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(c);
    }
    return map;
  }, [filtered]);

  const totalAirports = useMemo(
    () => countries.reduce((sum, c) => sum + c.airportCount, 0),
    [countries],
  );
  const regionCount = useMemo(
    () => new Set(countries.map((c) => c.region).filter(Boolean)).size,
    [countries],
  );

  const orderedRegions = REGION_ORDER.filter((r) => byRegion.has(r));

  return (
    <div className="mt-10">
      {/* Stat strip */}
      <div className="grid gap-6 rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 sm:grid-cols-3">
        <Stat label="Countries" value={countries.length.toLocaleString()} />
        <Stat label="Airports" value={totalAirports.toLocaleString()} />
        <Stat label="Regions" value={regionCount.toString()} />
      </div>

      {/* Search */}
      <div className="mt-8">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by country name or ISO code (e.g. AU, Japan)…"
          className="w-full rounded-[0.3rem] border border-forest-900/15 bg-paper px-4 py-3 font-sans text-base text-ink placeholder:text-forest-900/40 focus:border-terracotta-800 focus:outline-none focus:ring-2 focus:ring-forest-800/20"
          data-testid="country-search"
        />
      </div>

      {/* Region filter */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-forest-900/50">Region:</span>
        <FilterChip
          label="All"
          active={activeRegion === null}
          onClick={() => setActiveRegion(null)}
        />
        {REGION_ORDER.map((r) => (
          <FilterChip
            key={r}
            label={r}
            active={activeRegion === r}
            onClick={() => setActiveRegion(activeRegion === r ? null : r)}
          />
        ))}
      </div>

      {/* Results */}
      <div className="mt-10 grid gap-12 lg:grid-cols-[180px,1fr]">
        <nav className="hidden lg:block">
          <div className="sticky top-24 space-y-1">
            <p className="mb-3 text-xs uppercase tracking-widest text-forest-900/50">Jump to</p>
            {orderedRegions.map((r) => (
              <a
                key={r}
                href={`#region-${r.replace(/\s+/g, '-').toLowerCase()}`}
                className="block rounded-[0.3rem] px-3 py-2 text-sm text-forest-900/80 transition hover:bg-forest-900/5 hover:text-forest-900"
              >
                {r}
                <span className="ml-2 text-xs text-forest-900/40">{byRegion.get(r)?.length ?? 0}</span>
              </a>
            ))}
          </div>
        </nav>

        <div className="min-w-0">
          {filtered.length === 0 ? (
            <p className="mt-10 text-center text-forest-900/60" data-testid="countries-empty">
              No countries match that search. Try clearing a filter.
            </p>
          ) : (
            orderedRegions.map((r) => {
              const regionList = byRegion.get(r)!;
              const displayed = regionList.slice(0, PER_REGION_LIMIT);
              const overflow = regionList.length - displayed.length;
              return (
                <section
                  key={r}
                  id={`region-${r.replace(/\s+/g, '-').toLowerCase()}`}
                  className="mb-16 scroll-mt-24"
                >
                  <header className="flex items-baseline justify-between border-b border-forest-900/10 pb-3">
                    <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">{r}</h2>
                    <span className="text-sm font-light text-forest-900/50">
                      {regionList.length} countr{regionList.length === 1 ? 'y' : 'ies'}
                      {overflow > 0 && <span className="ml-2 text-forest-900/40">· showing {PER_REGION_LIMIT}</span>}
                    </span>
                  </header>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {displayed.map((c) => <CountryCard key={c.code} country={c} />)}
                  </div>
                  {overflow > 0 && (
                    <p className="mt-4 text-xs text-forest-900/50">
                      + {overflow.toLocaleString()} more in {r} — narrow with search.
                    </p>
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-urbanist text-3xl font-bold text-forest-900">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-widest text-forest-900/60">{label}</div>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wider transition ' +
        (active
          ? 'border-forest-900 bg-forest-900 text-sand-100'
          : 'border-forest-900/20 text-forest-900/80 hover:border-forest-900/40 hover:bg-forest-900/5')
      }
    >
      {label}
    </button>
  );
}

function CountryCard({ country }: { country: CountryRow }) {
  return (
    <Link
      href={`/countries/${country.code.toLowerCase()}`}
      className="group flex items-center gap-3 rounded-[0.3rem] border border-forest-900/10 bg-paper px-4 py-3 transition hover:-translate-y-0.5 hover:border-forest-900/30"
      data-testid={`country-card-${country.code}`}
    >
      <span className="flex h-10 w-10 flex-none items-center justify-center text-2xl" aria-hidden>
        {flagEmoji(country.code)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate font-urbanist text-sm font-bold text-forest-900 group-hover:text-forest-700">
            {country.name}
          </div>
          <span className="flex-none rounded-[0.3rem] bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
            {country.code}
          </span>
        </div>
        <div className="mt-1 truncate text-xs text-forest-900/60">
          {country.airportCount} airport{country.airportCount === 1 ? '' : 's'}
          {country.cityCount > 0 && <span className="ml-2 text-forest-900/40">· {country.cityCount} cit{country.cityCount === 1 ? 'y' : 'ies'}</span>}
        </div>
      </div>
    </Link>
  );
}
