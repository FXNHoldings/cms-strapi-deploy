import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start px-6 py-32" data-testid="not-found-page">
      <p className="chip">404</p>
      <h1 className="editorial-h mt-5 text-5xl font-black text-forest-900 lg:text-7xl">
        That trip<br /><em className="font-light text-terracotta-700">doesn't exist</em>.
      </h1>
      <p className="mt-5 text-lg text-ink/70">
        The page you're looking for moved, got unpublished, or never quite made it into the atlas.
      </p>
      <Link href="/" className="mt-8 rounded-full bg-forest-900 px-6 py-3 text-sm font-medium text-sand-100 hover:bg-forest-800">
        ← Back to the homepage
      </Link>
    </div>
  );
}
