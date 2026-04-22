/**
 * TravelPayouts / Aviasales deep-link builder.
 *
 * Aviasales URL format (used unchanged by white-label hosts):
 *   /search/{ORIGIN}{DDMM_depart}{DESTINATION}{DDMM_return}{pax}?marker=...&sub_id=...&airline=...
 *
 * Example round-trip LHR→BKK, depart 22 May, return 29 May, 1 pax:
 *   /search/LHR2205BKK29051
 *
 * Example one-way (omit return date):
 *   /search/LHR2205BKK1
 */

const WL_HOST = process.env.NEXT_PUBLIC_TP_WL_HOST || 'www.aviasales.com';
const MARKER = process.env.NEXT_PUBLIC_TP_MARKER;

/** Format a Date as Aviasales' compact DDMM (e.g. 22 May → "2205"). */
function formatDDMM(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}${mm}`;
}

/** Add N days to a date (UTC, avoids DST/TZ edge cases). */
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

export type FlightSearchOpts = {
  origin: string;                   // IATA, 3 chars
  destination: string;              // IATA, 3 chars
  subId?: string;                   // TP sub_id for per-page conversion tracking
  airline?: string;                 // IATA airline filter (e.g. "SQ")
  passengers?: number;              // default 1
  departDaysFromNow?: number;       // default 30
  tripLengthDays?: number | null;   // default 7; pass null for one-way
  /** Override dates directly (ISO strings "YYYY-MM-DD"). If set, overrides days-from-now. */
  departDate?: string;
  returnDate?: string | null;
};

export function flightSearchUrl(opts: FlightSearchOpts): string {
  const {
    origin,
    destination,
    subId,
    airline,
    passengers = 1,
    departDaysFromNow = 30,
    tripLengthDays = 7,
    departDate,
    returnDate,
  } = opts;

  const today = new Date();
  const depart = departDate ? new Date(departDate + 'T00:00:00Z') : addDays(today, departDaysFromNow);
  const ret =
    returnDate === null
      ? null
      : returnDate
        ? new Date(returnDate + 'T00:00:00Z')
        : tripLengthDays == null
          ? null
          : addDays(depart, tripLengthDays);

  const path =
    `${origin.toUpperCase()}${formatDDMM(depart)}${destination.toUpperCase()}${ret ? formatDDMM(ret) : ''}${passengers}`;

  const params = new URLSearchParams();
  if (MARKER) params.set('marker', MARKER);
  if (subId) params.set('sub_id', subId);
  if (airline) params.set('airline', airline.toUpperCase());

  const qs = params.toString();
  return `https://${WL_HOST}/search/${path}${qs ? `?${qs}` : ''}`;
}
