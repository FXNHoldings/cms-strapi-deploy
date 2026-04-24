'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { mediaUrl, type StrapiAirline, type AirlineRegion, type AirlineType } from '@/lib/strapi';

const REGION_ORDER: AirlineRegion[] = ['Oceania', 'Asia-Pacific', 'Europe', 'Americas', 'Middle East', 'Africa'];
const TYPE_OPTIONS: AirlineType[] = ['Scheduled', 'Low-cost', 'Regional', 'Charter', 'Cargo'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const PER_REGION_LIMIT = 15;

function firstLetterBucket(name: string): string {
  const first = (name ?? '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

export default function AirlineDirectory({ airlines }: { airlines: StrapiAirline[] }) {
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<AirlineType | null>(null);
  const [activeRegion, setActiveRegion] = useState<AirlineRegion | null>(null);
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return airlines.filter((a) => {
      if (activeType && a.type !== activeType) return false;
      if (activeRegion && a.region !== activeRegion) return false;
      if (activeLetter && firstLetterBucket(a.name) !== activeLetter) return false;
      if (!q) return true;
      const hay = [a.name, a.iataCode, a.icaoCode, a.country, a.city, a.legalName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [airlines, query, activeType, activeRegion, activeLetter]);

  // Which letters actually have airlines in the (base) dataset — used to grey out unused ones.
  const availableLetters = useMemo(() => {
    const set = new Set<string>();
    for (const a of airlines) set.add(firstLetterBucket(a.name));
    return set;
  }, [airlines]);

  const byRegion = useMemo(() => {
    const map = new Map<AirlineRegion, StrapiAirline[]>();
    for (const a of filtered) {
      const r = (a.region || 'Asia-Pacific') as AirlineRegion;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(a);
    }
    return map;
  }, [filtered]);

  const countryCount = useMemo(
    () => new Set(airlines.map((a) => a.country).filter(Boolean)).size,
    [airlines],
  );
  const regionCount = useMemo(
    () => new Set(airlines.map((a) => a.region).filter(Boolean)).size,
    [airlines],
  );

  const orderedRegions = REGION_ORDER.filter((r) => byRegion.has(r));

  return (
    <div className="mt-10">
      {/* Stat strip */}
      <div className="grid gap-6 rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 sm:grid-cols-3">
        <Stat label="Airlines" value={airlines.length.toString()} />
        <Stat label="Countries" value={countryCount.toString()} />
        <Stat label="Regions" value={regionCount.toString()} />
      </div>

      {/* Search + filters */}
      <div className="mt-8 grid gap-4 lg:grid-cols-[1fr,auto]">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, IATA code (e.g. SQ), country…"
          className="w-full rounded-[0.3rem] border border-forest-900/15 bg-paper px-4 py-3 font-sans text-base text-ink placeholder:text-forest-900/40 focus:border-terracotta-800 focus:outline-none focus:ring-2 focus:ring-forest-800/20"
          data-testid="airline-search"
        />
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip
            label="All types"
            active={activeType === null}
            onClick={() => setActiveType(null)}
          />
          {TYPE_OPTIONS.map((t) => (
            <FilterChip
              key={t}
              label={t}
              active={activeType === t}
              onClick={() => setActiveType(activeType === t ? null : t)}
            />
          ))}
        </div>
      </div>

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

      {/* A-Z letter filter */}
      <div className="mt-4 flex flex-wrap items-center gap-1">
        <span className="mr-2 text-xs uppercase tracking-widest text-forest-900/50">Letter:</span>
        <LetterChip
          label="All"
          active={activeLetter === null}
          onClick={() => setActiveLetter(null)}
        />
        {LETTERS.map((L) => (
          <LetterChip
            key={L}
            label={L}
            active={activeLetter === L}
            disabled={!availableLetters.has(L)}
            onClick={() => setActiveLetter(activeLetter === L ? null : L)}
          />
        ))}
        {availableLetters.has('#') && (
          <LetterChip
            label="#"
            active={activeLetter === '#'}
            onClick={() => setActiveLetter(activeLetter === '#' ? null : '#')}
          />
        )}
      </div>

      {/* Results */}
      <div className="mt-10 grid gap-12 lg:grid-cols-[180px,1fr]">
        {/* Sticky region nav (desktop) */}
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
            <p className="mt-10 text-center text-forest-900/60" data-testid="airlines-empty">
              No airlines match that search. Try clearing a filter.
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
                  data-testid={`region-${r.replace(/\s+/g, '-').toLowerCase()}`}
                >
                  <header className="flex items-baseline justify-between border-b border-forest-900/10 pb-3">
                    <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">{r}</h2>
                    <span className="text-sm font-light text-forest-900/50">
                      {regionList.length} airline{regionList.length === 1 ? '' : 's'}
                      {overflow > 0 && <span className="ml-2 text-forest-900/40">· showing {PER_REGION_LIMIT}</span>}
                    </span>
                  </header>
                  <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {displayed.map((a) => <AirlineCard key={a.id} airline={a} />)}
                  </div>
                  {overflow > 0 && (
                    <p className="mt-4 text-xs text-forest-900/50">
                      + {overflow.toLocaleString()} more in {r} — narrow with search, letter, or type filter.
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

function LetterChip({
  label,
  active,
  disabled = false,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={
        'inline-flex h-8 min-w-[2rem] items-center justify-center rounded-[0.3rem] border px-2 font-mono text-xs font-bold tracking-wider transition ' +
        (active
          ? 'border-forest-900 bg-forest-900 text-sand-100'
          : disabled
            ? 'cursor-not-allowed border-forest-900/10 text-forest-900/20'
            : 'border-forest-900/20 text-forest-900/80 hover:border-forest-900/40 hover:bg-forest-900/5')
      }
      data-testid={`letter-${label}`}
    >
      {label}
    </button>
  );
}

function AirlineCard({ airline }: { airline: StrapiAirline }) {
  const logo = mediaUrl(airline.logo ?? null);
  return (
    <Link
      href={`/airlines/${airline.slug}`}
      className="group flex items-center gap-4 rounded-[0.3rem] border border-forest-900/10 bg-paper p-4 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
      data-testid={`airline-card-${airline.slug}`}
    >
      <div className="flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-[0.3rem] bg-forest-900/5">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={airline.name} className="h-full w-full object-contain" />
        ) : (
          <span className="font-urbanist text-sm font-bold text-forest-900/60">
            {(airline.iataCode || airline.name).slice(0, 3).toUpperCase()}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate font-urbanist text-base font-bold text-forest-900 group-hover:text-forest-700">
            {airline.name}
          </div>
          {airline.iataCode && (
            <span className="flex-none rounded-[0.3rem] bg-forest-900 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-sand-100">
              {airline.iataCode}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-forest-900/60">
          {[airline.country, airline.city].filter(Boolean).join(' · ')}
          {airline.type && <span className="ml-2 text-forest-900/40">· {airline.type}</span>}
        </div>
      </div>
    </Link>
  );
}
