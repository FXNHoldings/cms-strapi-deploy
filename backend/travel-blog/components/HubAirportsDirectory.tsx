'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { mediaUrl, type StrapiAirport, type AirlineRegion } from '@/lib/strapi';

const REGION_ORDER: AirlineRegion[] = ['Africa', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];

function flagEmoji(code?: string): string {
  if (!code || code.length !== 2) return '✈️';
  const cc = code.toUpperCase();
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export default function HubAirportsDirectory({ airports }: { airports: StrapiAirport[] }) {
  const [query, setQuery] = useState('');
  const [activeRegion, setActiveRegion] = useState<AirlineRegion | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return airports.filter((a) => {
      if (activeRegion && a.region !== activeRegion) return false;
      if (!q) return true;
      const hay = [a.name, a.iata, a.icao, a.city, a.country].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [airports, query, activeRegion]);

  const byRegion = useMemo(() => {
    const map = new Map<AirlineRegion, StrapiAirport[]>();
    for (const a of filtered) {
      const r = (a.region || 'Asia') as AirlineRegion;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(a);
    }
    return map;
  }, [filtered]);

  const orderedRegions = REGION_ORDER.filter((r) => byRegion.has(r));

  return (
    <div className="mt-10">
      {/* Stat strip */}
      <div className="grid gap-6 rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 sm:grid-cols-3">
        <Stat label="Hubs" value={airports.length.toLocaleString()} />
        <Stat label="Continents" value={new Set(airports.map((a) => a.region).filter(Boolean)).size.toString()} />
        <Stat label="Countries" value={new Set(airports.map((a) => a.country).filter(Boolean)).size.toLocaleString()} />
      </div>

      {/* Search */}
      <div className="mt-8">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search hubs by name, IATA (e.g. DXB), city, country…"
          className="w-full rounded-[0.3rem] border border-forest-900/15 bg-paper px-4 py-3 font-sans text-base text-ink placeholder:text-forest-900/40 focus:border-terracotta-800 focus:outline-none focus:ring-2 focus:ring-forest-800/20"
          data-testid="hub-search"
        />
      </div>

      {/* Continent filter */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-forest-900/50">Continent:</span>
        <FilterChip label="All" active={activeRegion === null} onClick={() => setActiveRegion(null)} />
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
      {filtered.length === 0 ? (
        <div className="mt-10 rounded-3xl border border-dashed border-forest-900/15 p-12 text-center">
          <p className="font-light text-forest-900/60">No hubs match your filter.</p>
        </div>
      ) : (
        <div className="mt-10 space-y-12">
          {orderedRegions.map((r) => {
            const list = byRegion.get(r)!;
            return (
              <section key={r} id={`region-${r.replace(/\s+/g, '-').toLowerCase()}`}>
                <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
                  <h2 className="editorial-h text-2xl font-bold text-forest-900">{r}</h2>
                  <span className="text-sm font-light text-forest-900/50">
                    {list.length} {list.length === 1 ? 'hub' : 'hubs'}
                  </span>
                </header>
                <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((a) => (
                    <li key={a.id}>
                      <HubCard airport={a} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HubCard({ airport }: { airport: StrapiAirport }) {
  const img = mediaUrl(airport.heroImage ?? null);
  return (
    <Link
      href={`/airports/${airport.iata}`}
      className="group flex h-full overflow-hidden rounded-lg border border-forest-900/10 bg-paper transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
      data-testid={`hub-card-${airport.iata}`}
    >
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={airport.name}
          className="h-32 w-40 shrink-0 object-cover transition duration-500 group-hover:scale-[1.02]"
        />
      ) : (
        <div className="flex h-32 w-40 shrink-0 items-center justify-center bg-forest-900/10 font-mono text-xl font-bold text-forest-900/40">
          {airport.iata}
        </div>
      )}
      <div className="flex flex-1 flex-col justify-center p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-forest-900/60">
          <span className="font-mono font-bold text-forest-900">{airport.iata}</span>
          {airport.icao && <span className="font-mono opacity-70">{airport.icao}</span>}
        </div>
        <div className="font-urbanist mt-1 text-base font-bold leading-snug text-forest-900 transition group-hover:text-forest-700">
          {airport.name}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-forest-900/70">
          <span aria-hidden>{flagEmoji(airport.countryCode)}</span>
          <span>{airport.city || airport.country}</span>
        </div>
      </div>
    </Link>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-full px-3 py-1 text-xs font-medium transition ' +
        (active
          ? 'bg-forest-900 text-sand-100'
          : 'bg-forest-900/5 text-forest-900/70 hover:bg-forest-900/10')
      }
    >
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-urbanist text-3xl font-bold leading-none text-forest-900">{value}</div>
      <div className="mt-2 text-xs uppercase tracking-widest text-forest-900/60">{label}</div>
    </div>
  );
}
