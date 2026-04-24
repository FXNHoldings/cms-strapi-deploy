import Link from 'next/link';
import type { Metadata } from 'next';
import { LEGAL_DOCS } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Legal — Originfacts',
  description:
    'Terms, privacy, cookies, affiliate disclosure, disclaimer, accessibility, and contact details for Originfacts.',
};

export default function LegalIndexPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16" data-testid="legal-index">
      <header className="max-w-3xl">
        <p className="chip">Legal</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold text-forest-900 sm:text-4xl">
          Legal &amp; policies
        </h1>
        <p className="mt-4 text-lg font-light text-forest-900/70">
          Terms, privacy, cookies, disclosures, and accessibility — everything that tells you
          how Originfacts works, how we use data, and how to reach us.
        </p>
      </header>

      <ul className="mt-12 grid gap-4 sm:grid-cols-2">
        {LEGAL_DOCS.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/legal/${doc.slug}`}
              className="group block rounded-lg border border-forest-900/10 bg-paper p-6 transition hover:-translate-y-0.5 hover:border-forest-900/30 hover:shadow-sm"
              data-testid={`legal-link-${doc.slug}`}
            >
              <div className="font-urbanist text-lg font-bold text-forest-900 group-hover:text-forest-700">
                {doc.title}
              </div>
              <p className="mt-2 text-sm text-forest-900/70">{doc.description}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-forest-700">
                Read
                <span aria-hidden>→</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
