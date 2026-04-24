import { hotelSearchUrl } from '@/lib/affiliate';

export default function HotelSearchCTA({
  destination,
  subId,
  variant = 'section',
}: {
  destination: string;
  subId?: string;
  /** `section` = full-width card block on a page; `inline` = compact CTA inside prose */
  variant?: 'section' | 'inline';
}) {
  const href = hotelSearchUrl({ destination, subId });

  if (variant === 'inline') {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener sponsored"
        className="inline-flex items-center gap-2 rounded-lg border border-forest-900/15 bg-paper px-4 py-2 text-sm font-medium text-forest-900 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
        data-testid={`hotel-cta-inline-${subId ?? 'generic'}`}
      >
        Find hotels in {destination}
        <span aria-hidden>→</span>
      </a>
    );
  }

  return (
    <section className="mx-auto mt-16 max-w-7xl px-6" data-testid={`hotel-cta-${subId ?? 'generic'}`}>
      <div className="rounded-lg border border-forest-900/10 bg-forest-50 p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl">
            <div className="text-xs uppercase tracking-widest text-forest-800/70">
              Where to stay
            </div>
            <h2 className="editorial-h mt-2 text-2xl font-bold text-forest-900 lg:text-2xl">
              Hotels in {destination}
            </h2>
            <p className="mt-3 text-sm leading-6 text-forest-900/75 sm:text-base">
              Compare prices across Booking.com, Agoda, Hotels.com, and more in one search —
              from boutique stays to budget beds.
            </p>
          </div>
          <a
            href={href}
            target="_blank"
            rel="noopener sponsored"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-forest-900 px-6 py-3 font-urbanist text-sm font-bold uppercase tracking-wider text-sand-100 transition hover:bg-forest-700"
          >
            Find hotels
            <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </section>
  );
}
