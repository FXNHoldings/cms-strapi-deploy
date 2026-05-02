'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { StrapiRoute, AirlineRegion } from '@/lib/strapi';

const REGION_ORDER: AirlineRegion[] = ['Africa', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];

export default function RouteDirectory({ routes }: { routes: StrapiRoute[] }) {
  const [query, setQuery] = useState('');
  const [activeRegion, setActiveRegion] = useState<AirlineRegion | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return routes.filter((r) => {
      if (!r.origin || !r.destination) return false;
      if (activeRegion && r.origin.region !== activeRegion) return false;
      if (!q) return true;
      const hay = [
        r.origin.iata,
        r.origin.city,
        r.origin.country,
        r.origin.name,
        r.destination.iata,
        r.destination.city,
        r.destination.country,
        r.destination.name,
        r.slug,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [routes, query, activeRegion]);

  const byRegion = useMemo(() => {
    const map = new Map<AirlineRegion, StrapiRoute[]>();
    for (const r of filtered) {
      const region = (r.origin?.region || 'Asia') as AirlineRegion;
      if (!map.has(region)) map.set(region, []);
      map.get(region)!.push(r);
    }
    return map;
  }, [filtered]);

  const originCount = useMemo(
    () => new Set(routes.map((r) => r.origin?.iata).filter(Boolean)).size,
    [routes],
  );
  const destinationCount = useMemo(
    () => new Set(routes.map((r) => r.destination?.iata).filter(Boolean)).size,
    [routes],
  );

  const orderedRegions = REGION_ORDER.filter((r) => byRegion.has(r));

  return (
    <div className="mt-10">
      {/* Stat strip */}
      <div className="grid gap-6 rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 sm:grid-cols-3">
        <Stat label="Routes" value={routes.length.toLocaleString()} />
        <Stat label="Origins" value={originCount.toLocaleString()} />
        <Stat label="Destinations" value={destinationCount.toLocaleString()} />
      </div>

      {/* Search */}
      <div className="mt-8">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by city, IATA (e.g. LHR), country, or route…"
          className="w-full rounded-[0.3rem] border border-forest-900/15 bg-paper px-4 py-3 font-sans text-base text-ink placeholder:text-forest-900/40 focus:border-terracotta-800 focus:outline-none focus:ring-2 focus:ring-forest-800/20"
          data-testid="route-search"
        />
      </div>

      {/* Region filter (by origin region) */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-forest-900/50">Departing from:</span>
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
            <p className="mt-10 text-center text-forest-900/60" data-testid="routes-empty">
              No routes match that search. Try clearing a filter.
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
                    {byRegion.get(r)!.length} route{byRegion.get(r)!.length === 1 ? '' : 's'}
                  </span>
                </header>
                <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {byRegion.get(r)!.slice(0, 120).map((rt) => <RouteCard key={rt.id} route={rt} />)}
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

function RouteCard({ route }: { route: StrapiRoute }) {
  const o = route.origin!;
  const d = route.destination!;
  return (
    <Link
      href={`/flights/${route.slug}`}
      className="group flex flex-col gap-2 rounded-[0.3rem] border border-forest-900/10 bg-paper px-4 py-3 transition hover:-translate-y-0.5 hover:border-forest-900/30"
      data-testid={`route-card-${route.slug}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex-none rounded-[0.3rem] bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
          {o.iata}
        </span>
        <span className="text-forest-900/40">→</span>
        <span className="flex-none rounded-[0.3rem] bg-forest-700 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
          {d.iata}
        </span>
      </div>
      <div className="min-w-0">
        <div className="truncate font-urbanist text-sm font-bold text-forest-900 group-hover:text-forest-700">
          {o.city || o.name} → {d.city || d.name}
        </div>
        <div className="mt-1 truncate text-xs text-forest-900/60">
          {o.country && d.country
            ? `${o.country} · ${d.country}`
            : (o.country || d.country || '')}
          {route.carriers && route.carriers.length > 0 && (
            <span className="ml-2 text-forest-900/40">
              · {route.carriers.length} carrier{route.carriers.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
