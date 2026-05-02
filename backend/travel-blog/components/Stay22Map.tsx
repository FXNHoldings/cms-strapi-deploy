import { alloraEmbedUrl, isStay22Configured, type Stay22Opts } from '@/lib/stay22';

type Props = Stay22Opts & {
  /** Display name shown in the heading (defaults to `address`). */
  title?: string;
  /** Iframe height in CSS units. Default 600px. */
  height?: string;
  className?: string;
};

export default function Stay22Map({
  title,
  height = '600px',
  className = '',
  ...opts
}: Props) {
  if (!isStay22Configured()) return null;

  const src = alloraEmbedUrl(opts);
  const heading = title ?? opts.address;

  return (
    <section
      className={`mx-auto max-w-7xl px-6 ${className}`}
      data-testid={`stay22-map-${opts.subId ?? 'generic'}`}
    >
      <header className="flex items-end justify-between border-b border-forest-900/10 pb-3">
        <div>
          <p className="chip">Where to stay</p>
          <h2 className="editorial-h mt-2 text-2xl font-bold text-forest-900 lg:text-2xl">
            Hotels &amp; stays in {heading}
          </h2>
        </div>
        <span className="text-sm font-light text-forest-900/50">
          Powered by Stay22
        </span>
      </header>

      <div
        className="mt-6 overflow-hidden rounded-lg border border-forest-900/10 bg-paper"
        style={{ height }}
      >
        <iframe
          src={src}
          title={`Map of hotels in ${heading}`}
          loading="lazy"
          referrerPolicy="origin"
          className="h-full w-full"
          allow="geolocation"
        />
      </div>

      <p className="mt-3 text-xs text-forest-900/50">
        Stays shown via Stay22 — booking is handled by Booking.com, Airbnb, VRBO, Hotels.com or Expedia.
        We may earn a commission from qualifying bookings.
      </p>
    </section>
  );
}
