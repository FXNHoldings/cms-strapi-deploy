'use client';

import { useEffect, useRef } from 'react';

/**
 * TravelPayouts "Price Calendar" widget (tpscr.com).
 *
 * Pre-populated with origin/destination IATA codes when provided — the widget
 * reads `origin_iata` / `destination_iata` from its script URL and pre-fills
 * the form. Clicks on the calendar push users to `searchUrl` (our WL).
 *
 * The widget is a third-party script that injects its own DOM into the
 * container. We append the script on mount and clear the container on
 * route change so it re-initializes with new origin/destination.
 */
export default function PriceCalendar({
  origin,
  destination,
}: {
  origin?: string;
  destination?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const params = new URLSearchParams({
      currency: 'usd',
      trs: '401311',
      shmarker: '314807',
      searchUrl: 'flights.originfacts.com/flights',
      locale: 'en',
      powered_by: 'false',
      one_way: 'false',
      only_direct: 'false',
      period: 'year',
      range: '7,14',
      primary: '#0C73FE',
      color_background: '#ffffff',
      dark: '#000000',
      light: '#FFFFFF',
      achieve: '#45AD35',
      promo_id: '4041',
      campaign_id: '100',
    });
    // TP widgets pre-fill via various param names depending on template.
    // Pass all common variants — widgets ignore unknown params.
    if (origin) {
      const o = origin.toUpperCase();
      params.set('origin', o);
      params.set('origin_iata', o);
      params.set('origin_code', o);
    }
    if (destination) {
      const d = destination.toUpperCase();
      params.set('destination', d);
      params.set('destination_iata', d);
      params.set('destination_code', d);
    }

    const script = document.createElement('script');
    script.async = true;
    script.charset = 'utf-8';
    script.src = `https://tpscr.com/content?${params.toString()}`;
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, [origin, destination]);

  return <div ref={containerRef} className="tp-price-calendar" data-testid="price-calendar" />;
}
