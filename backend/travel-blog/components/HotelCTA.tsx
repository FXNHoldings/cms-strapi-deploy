import Link from 'next/link';
import { allezLink } from '@/lib/stay22';

type Props = {
  /** Human-readable destination name (city / country / region). */
  destination: string;
  /** Sub-id for conversion tracking; passed through as Stay22 `campaign`. */
  subId?: string;
  /** When provided, the section button also links to the in-site /hotels/[slug] page. */
  hotelsSlug?: string;
  /** `section` = full-width card block on a page; `inline` = compact CTA inside prose. */
  variant?: 'section' | 'inline';
};

export default function HotelCTA({
  destination,
  subId,
  hotelsSlug,
  variant = 'section',
}: Props) {
  const href = allezLink({ address: destination, subId });

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
    <section
      className="mx-auto mt-16 max-w-7xl px-6"
      data-testid={`hotel-cta-${subId ?? 'generic'}`}
    >
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
              Compare prices across Booking.com, Airbnb, VRBO, Hotels.com and Expedia in one
              search — from boutique hotels to vacation rentals.
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <a
              href={href}
              target="_blank"
              rel="noopener sponsored"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-forest-900 px-6 py-3 font-urbanist text-sm font-bold uppercase tracking-wider text-sand-100 transition hover:bg-forest-700"
            >
              Find hotels
              <span aria-hidden>→</span>
            </a>
            {hotelsSlug && (
              <Link
                href={`/hotels/${hotelsSlug}`}
                className="text-xs font-medium text-forest-700 hover:underline"
              >
                See map of stays →
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
