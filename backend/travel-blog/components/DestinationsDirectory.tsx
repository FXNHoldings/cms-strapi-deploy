'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { mediaUrl, type StrapiDestination } from '@/lib/strapi';

type Filter = 'all' | 'region' | 'country' | 'city';
const SECTION_LIMIT = 8;

export default function DestinationsDirectory({
  destinations,
}: {
  destinations: StrapiDestination[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const initialType = (params.get('type') as Filter | null) ?? 'all';
  const initialQuery = params.get('q') ?? '';

  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>(
    ['all', 'region', 'country', 'city'].includes(initialType) ? initialType : 'all',
  );

  // Keep URL in sync so "view all" links and direct URLs work bidirectionally.
  useEffect(() => {
    const next = new URLSearchParams();
    if (filter !== 'all') next.set('type', filter);
    if (query.trim()) next.set('q', query.trim());
    const qs = next.toString();
    router.replace(qs ? `/destinations?${qs}` : '/destinations', { scroll: false });
  }, [filter, query, router]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return destinations.filter((d) => {
      if (!q) return true;
      return [d.name, d.countryCode, d.type, d.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [destinations, query]);

  const byType = useMemo(() => {
    const buckets: Record<'region' | 'country' | 'city', StrapiDestination[]> = {
      region: [],
      country: [],
      city: [],
    };
    for (const d of matches) {
      if (d.type === 'region' || d.type === 'country' || d.type === 'city') {
        buckets[d.type].push(d);
      }
    }
    return buckets;
  }, [matches]);

  const flatShown = filter === 'all' ? matches : byType[filter];
  const isFlat = filter !== 'all' || query.trim().length > 0;

  return (
    <div className="mt-10">
      {/* Stat strip */}
      <div className="grid gap-6 rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6 sm:grid-cols-4">
        <Stat label="Total" value={destinations.length.toLocaleString()} />
        <Stat label="Regions" value={byType.region.length.toLocaleString()} />
        <Stat label="Countries" value={byType.country.length.toLocaleString()} />
        <Stat label="Cities" value={byType.city.length.toLocaleString()} />
      </div>

      {/* Search */}
      <div className="mt-8">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search destinations — name, country code, or keyword…"
          className="w-full rounded-[0.3rem] border border-forest-900/15 bg-paper px-4 py-3 font-sans text-base text-ink placeholder:text-forest-900/40 focus:border-terracotta-800 focus:outline-none focus:ring-2 focus:ring-forest-800/20"
          data-testid="destination-search"
        />
      </div>

      {/* Filter chips */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-forest-900/50">Show:</span>
        <FilterChip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterChip label="Regions" active={filter === 'region'} onClick={() => setFilter('region')} />
        <FilterChip label="Countries" active={filter === 'country'} onClick={() => setFilter('country')} />
        <FilterChip label="Cities" active={filter === 'city'} onClick={() => setFilter('city')} />
      </div>

      {/* Results */}
      {isFlat ? (
        <FlatResults items={flatShown} query={query} filter={filter} />
      ) : (
        <>
          {byType.region.length > 0 && (
            <SectionHeader
              title="Regions"
              count={byType.region.length}
              onViewAll={byType.region.length > SECTION_LIMIT ? () => setFilter('region') : undefined}
            />
          )}
          {byType.region.length > 0 && <RegionsLayout items={byType.region.slice(0, SECTION_LIMIT)} />}

          {byType.country.length > 0 && (
            <SectionHeader
              title="Countries"
              count={byType.country.length}
              onViewAll={byType.country.length > SECTION_LIMIT ? () => setFilter('country') : undefined}
            />
          )}
          {byType.country.length > 0 && <CountriesLayout items={byType.country.slice(0, SECTION_LIMIT)} />}

          {byType.city.length > 0 && (
            <SectionHeader
              title="Cities"
              count={byType.city.length}
              onViewAll={byType.city.length > SECTION_LIMIT ? () => setFilter('city') : undefined}
            />
          )}
          {byType.city.length > 0 && <CitiesLayout items={byType.city.slice(0, SECTION_LIMIT)} />}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Layouts                                                                    */
/* -------------------------------------------------------------------------- */

/** Regions — 2-column wide mosaic, 16:9 tiles, larger display typography. */
function RegionsLayout({ items }: { items: StrapiDestination[] }) {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      {items.map((d) => (
        <DestinationTile key={d.id} d={d} aspect="aspect-[16/9]" size="lg" />
      ))}
    </div>
  );
}

/** Countries — first is a 2x2 hero, rest fill a 4-col grid; total up to 8 visible. */
function CountriesLayout({ items }: { items: StrapiDestination[] }) {
  const [hero, ...rest] = items;
  if (!hero) return null;
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-4">
      <div className="sm:col-span-2 sm:row-span-2">
        <DestinationTile d={hero} aspect="aspect-[4/5] sm:aspect-auto sm:h-full" size="xl" />
      </div>
      {rest.map((d) => (
        <DestinationTile key={d.id} d={d} aspect="aspect-[3/4]" size="md" />
      ))}
    </div>
  );
}

/** Cities — tight 4-col grid with portrait cards. */
function CitiesLayout({ items }: { items: StrapiDestination[] }) {
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((d) => (
        <DestinationTile key={d.id} d={d} aspect="aspect-[3/4]" size="sm" />
      ))}
    </div>
  );
}

function FlatResults({
  items,
  query,
  filter,
}: {
  items: StrapiDestination[];
  query: string;
  filter: Filter;
}) {
  if (items.length === 0) {
    return (
      <p className="mt-10 text-center text-forest-900/60" data-testid="destinations-empty">
        No destinations match
        {query ? ` “${query}”` : ''}
        {filter !== 'all' ? ` in ${filter}s` : ''}.
      </p>
    );
  }
  return (
    <div className="mt-8">
      <p className="text-xs uppercase tracking-widest text-forest-900/50">
        {items.length} result{items.length === 1 ? '' : 's'}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((d) => (
          <DestinationTile key={d.id} d={d} aspect="aspect-[3/4]" size="sm" />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function SectionHeader({
  title,
  count,
  onViewAll,
}: {
  title: string;
  count: number;
  onViewAll?: () => void;
}) {
  return (
    <header className="mt-16 flex items-end justify-between border-b border-forest-900/10 pb-3">
      <h2 className="editorial-h text-2xl font-bold text-forest-900 lg:text-3xl">{title}</h2>
      <div className="flex items-center gap-4 text-sm">
        <span className="font-light text-forest-900/50">
          {count} {title.toLowerCase()}
        </span>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="font-medium text-forest-700 hover:underline"
          >
            View all →
          </button>
        )}
      </div>
    </header>
  );
}

function DestinationTile({
  d,
  aspect,
  size,
}: {
  d: StrapiDestination;
  aspect: string;
  size: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const img = mediaUrl(d.heroImage ?? null);
  const titleClass =
    size === 'xl'
      ? 'text-2xl sm:text-3xl'
      : size === 'lg'
        ? 'text-xl sm:text-2xl'
        : size === 'md'
          ? 'text-xl'
          : 'text-base';
  return (
    <Link
      href={`/destinations/${d.slug}`}
      className={`group relative block overflow-hidden rounded-2xl bg-forest-800 ${aspect}`}
      data-testid={`destination-${d.slug}`}
    >
      {img && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          alt={d.name}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-110"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-forest-950/90 via-forest-950/30 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-4 text-sand-100 sm:p-5">
        {d.type && (
          <div className="text-[10px] uppercase tracking-widest opacity-70">
            {d.type}
            {d.countryCode && <span className="ml-2 opacity-80">· {d.countryCode}</span>}
          </div>
        )}
        <div className={`editorial-h mt-1 font-bold ${titleClass}`}>{d.name}</div>
      </div>
    </Link>
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
