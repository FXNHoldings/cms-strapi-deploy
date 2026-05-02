/**
 * Stay22 deep-link builders.
 *
 * Two products from one affiliate ID (`aid`):
 *
 *   1. Allez deep link — single URL that lands the visitor in Stay22's brand
 *      chooser (Booking.com, Airbnb, VRBO, Hotels.com, Expedia, …). Use for
 *      every "Find hotels" CTA / button.
 *
 *        https://www.stay22.com/allez/roam?aid=AID&address=Paris&campaign=SUB
 *
 *   2. Map embed — interactive iframe map of stays + restaurants around an
 *      address. Use as a section on hotel landing pages.
 *
 *        https://www.stay22.com/embed/gm?aid=AID&address=Paris&campaign=SUB
 *
 * The `aid` is public — it's safe in the client bundle. We read it from
 * NEXT_PUBLIC_STAY22_AID so it's available on the server and in the client.
 *
 * Docs: https://community.stay22.com/allez-deep-links-everything-you-need-to-know
 */

const AID = process.env.NEXT_PUBLIC_STAY22_AID;

export type Stay22Opts = {
  /** Human-readable city / country / address (Stay22 geocodes this server-side). */
  address: string;
  /** YYYY-MM-DD */
  checkIn?: string;
  /** YYYY-MM-DD */
  checkOut?: string;
  /** Default 2. */
  adults?: number;
  /** Default 0. */
  children?: number;
  /** Sub-id for per-page conversion tracking — Stay22 calls this `campaign`. */
  subId?: string;
  /** Optional ISO currency override (e.g. "USD", "GBP"). */
  currency?: string;
  /** Optional 2-letter language override (e.g. "en", "es"). */
  lang?: string;
};

function buildParams(opts: Stay22Opts): URLSearchParams {
  const params = new URLSearchParams();
  if (AID) params.set('aid', AID);
  params.set('address', opts.address);
  if (opts.checkIn) params.set('checkin', opts.checkIn);
  if (opts.checkOut) params.set('checkout', opts.checkOut);
  params.set('adults', String(opts.adults ?? 2));
  if (opts.children && opts.children > 0) params.set('children', String(opts.children));
  if (opts.subId) params.set('campaign', opts.subId);
  if (opts.currency) params.set('currency', opts.currency);
  if (opts.lang) params.set('lang', opts.lang);
  return params;
}

/** Allez deep link — single URL, all major OTAs behind one chooser. */
export function allezLink(opts: Stay22Opts): string {
  return `https://www.stay22.com/allez/roam?${buildParams(opts).toString()}`;
}

/** Map iframe `src`. Wrap in <Stay22Map /> rather than embedding raw. */
export function alloraEmbedUrl(opts: Stay22Opts): string {
  return `https://www.stay22.com/embed/gm?${buildParams(opts).toString()}`;
}

/** True when an `aid` is configured. Pages can use this to render a fallback. */
export function isStay22Configured(): boolean {
  return Boolean(AID);
}
