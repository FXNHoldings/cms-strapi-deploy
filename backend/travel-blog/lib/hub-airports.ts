/**
 * Top 100 international hub airports — curated list of the world's most-trafficked
 * international gateways, organised for geographic spread.
 *
 * Source: ACI World "Busiest airports by international passenger traffic" + a
 * deliberate fill-in for regional anchors so every continent has representation.
 *
 * Used by:
 *   - `/airports/hubs` (dedicated page listing all 100 with filters)
 *   - `/airports` (top-of-page "Top international hubs" callout)
 *
 * To add or remove an airport, edit this file. No schema change needed —
 * membership is determined by IATA code presence in this set.
 */

export const HUB_AIRPORT_IATAS = [
  /* North America (18) */
  'ATL', 'LAX', 'ORD', 'JFK', 'EWR', 'DFW', 'MIA', 'SFO', 'IAD', 'IAH',
  'LAS', 'BOS', 'SEA', 'YYZ', 'YVR', 'YUL', 'MEX', 'CUN',

  /* Europe (28) */
  'LHR', 'CDG', 'AMS', 'FRA', 'IST', 'MAD', 'MUC', 'BCN', 'LGW', 'FCO',
  'ORY', 'ZRH', 'VIE', 'DUB', 'CPH', 'ARN', 'OSL', 'HEL', 'BRU', 'LIS',
  'ATH', 'WAW', 'PRG', 'MAN', 'DUS', 'BER', 'MXP', 'GVA',

  /* Middle East (8) */
  'DXB', 'DOH', 'AUH', 'JED', 'RUH', 'KWI', 'TLV', 'BAH',

  /* Asia (26) */
  'HKG', 'SIN', 'ICN', 'NRT', 'HND', 'BKK', 'KUL', 'TPE', 'PEK', 'PVG',
  'CAN', 'CTU', 'KIX', 'DEL', 'BOM', 'BLR', 'HYD', 'MAA', 'SZX', 'HAN',
  'SGN', 'CGK', 'DPS', 'MNL', 'KTM', 'CMB',

  /* Oceania (5) */
  'SYD', 'MEL', 'BNE', 'PER', 'AKL',

  /* Africa (8) */
  'JNB', 'CPT', 'CAI', 'ADD', 'LOS', 'NBO', 'CMN', 'ALG',

  /* South America (7) */
  'GRU', 'EZE', 'BOG', 'SCL', 'LIM', 'GIG', 'PTY',
] as const;

export const HUB_AIRPORT_SET: ReadonlySet<string> = new Set(HUB_AIRPORT_IATAS);

export function isHubAirport(iata: string | null | undefined): boolean {
  if (!iata) return false;
  return HUB_AIRPORT_SET.has(iata.toUpperCase());
}
