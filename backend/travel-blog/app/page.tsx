export default function UnderConstruction() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-forest-950 px-6 text-sand-100" data-testid="under-construction">
      <div className="max-w-2xl text-center">
        <p className="font-urbanist text-xs uppercase tracking-[0.3em] text-sand-200/70" data-testid="uc-eyebrow">
          Originfacts · 2026
        </p>
        <h1 className="editorial-h mt-8 text-5xl font-black leading-[0.98] lg:text-7xl" data-testid="uc-title">
          Something worth<br />
          <span className="font-light italic text-sand-200">waiting for.</span>
        </h1>
        <p className="mt-8 text-lg font-light text-sand-100/80 lg:text-xl">
          A sharper way to plan travel — honest reviews, cheap-flight tactics,
          and hand-picked itineraries. Coming soon.
        </p>
        <p className="mt-16 text-xs uppercase tracking-[0.25em] text-sand-200/40">
          Under construction
        </p>
      </div>
    </main>
  );
}
