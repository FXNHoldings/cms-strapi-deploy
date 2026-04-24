import Script from 'next/script';

export const metadata = {
  title: 'Search Flights',
  description: 'Search hundreds of airlines in one place. Powered by our travel partners.',
};

export default function FlyPage() {
  return (
    <>
      {/* TravelPayouts white-label loader (wl_id=16626).
          No resultsURL is set — when the user submits, TPWL detects the
          #tpwl-tickets container on this same page and renders results
          in place, so the user stays on /fly. */}
      <Script id="tpwl-loader" strategy="afterInteractive">
        {`(function () {
  var script = document.createElement("script");
  script.async = 1;
  script.type = "module";
  script.src = "https://tpscr.com/wl_web/main.js?wl_id=16677";
  document.head.appendChild(script);
})();`}
      </Script>

      <div className="mx-auto max-w-7xl px-6 py-16" data-testid="fly-page">
        <header className="max-w-3xl">
          <p className="chip">Search</p>
          <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900">
            Find a flight
          </h1>
          <p className="mt-4 text-lg font-light text-forest-900/70">
            Search hundreds of airlines at once. Results appear below, no page jump.
          </p>
        </header>

        <div className="mt-10">
          <div id="tpwl-search" />
        </div>

        <div className="mt-12">
          <div id="tpwl-tickets" />
        </div>
      </div>
    </>
  );
}
