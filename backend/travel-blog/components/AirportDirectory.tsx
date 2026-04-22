'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { StrapiAirport, AirlineRegion } from '@/lib/strapi';

const REGION_ORDER: AirlineRegion[] = ['Oceania', 'Asia-Pacific', 'Europe', 'Americas', 'Middle East', 'Africa'];

export default function AirportDirectory({ airports }: { airports: StrapiAirport[] }) {
  const [query, setQuery] = useState('');
  const [activeRegion, setActiveRegion] = useState<AirlineRegion | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return airports.filter((a) => {
      if (activeRegion && a.region !== activeRegion) return false;
      if (!q) return true;
      const hay = [a.name, a.iata, a.icao, a.city, a.country]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [airports, query, activeRegion]);

  const byRegion = useMemo(() => {
    const map = new Map<AirlineRegion, StrapiAirport[]>();
    for (const a of filtered) {
      const r = (a.region || 'Asia-Pacific') as AirlineRegion;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(a);
    }
    return map;
  }, [filtered]);

  const countryCount = useMemo(
    () => new Set(airports.map((a) => a.country).filter(Boolean)).size,
    [airports],
  );
  const regionCount = useMemo(
    () => new Set(airports.map((a) => a.region).filter(Boolean)).size,
    [airports],
  );

  const orderedRegions = REGION_ORDER.filter((r) => byRegion.has(r));

  return (
    <div className="mt-10">
      {/* Stat strip */}
      <div className="grid gap-6 rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 sm:grid-cols-3">
        <Stat label="Airports" value={airports.length.toLocaleString()} />
        <Stat label="Countries" value={countryCount.toLocaleString()} />
        <Stat label="Regions" value={regionCount.toString()} />
      </div>

      {/* Search */}
      <div className="mt-8">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, IATA code (e.g. LHR), city, country…"
          className="w-full rounded-[0.3rem] border border-forest-900/15 bg-paper px-4 py-3 font-sans text-base text-ink placeholder:text-forest-900/40 focus:border-forest-800 focus:outline-none focus:ring-2 focus:ring-forest-800/20"
          data-testid="airport-search"
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
            <p className="mt-10 text-center text-forest-900/60" data-testid="airports-empty">
              No airports match that search. Try clearing a filter.
            </p>
          ) : (
            orderedRegions.map((r) => (
              <section
                key={r}
                id={`region-${r.replace(/\s+/g, '-').toLowerCase()}`}
                className="mb-16 scroll-mt-24"
              >
                <header className="flex items-baseline justify-between border-b border-forest-900/10 pb-3">
                  <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">{r}</h2>
                  <span className="text-sm font-light text-forest-900/50">
                    {byRegion.get(r)!.length} airport{byRegion.get(r)!.length === 1 ? '' : 's'}
                  </span>
                </header>
                <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {byRegion.get(r)!.slice(0, 120).map((a) => <AirportCard key={a.id} airport={a} />)}
                </div>
                {byRegion.get(r)!.length > 120 && (
                  <p className="mt-4 text-xs text-forest-900/50">
                    + {byRegion.get(r)!.length - 120} more in {r} — use search to narrow.
                  </p>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-urbanist text-3xl font-black text-forest-900 lg:text-4xl">{value}</div>
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

function AirportCard({ airport }: { airport: StrapiAirport }) {
  return (
    <Link
      href={`/airports/${airport.iata.toLowerCase()}`}
      className="group flex items-center justify-between gap-3 rounded-[0.3rem] border border-forest-900/10 bg-paper px-4 py-3 transition hover:-translate-y-0.5 hover:border-forest-900/30"
      data-testid={`airport-card-${airport.iata}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="flex-none rounded-[0.3rem] bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
            {airport.iata}
          </span>
          <div className="truncate font-urbanist text-sm font-bold text-forest-900 group-hover:text-terracotta-700">
            {airport.city || airport.name}
          </div>
        </div>
        <div className="mt-1 truncate text-xs text-forest-900/60">
          {airport.name}
          {airport.country && <span className="ml-2 text-forest-900/40">· {airport.country}</span>}
        </div>
      </div>
    </Link>
  );
}
