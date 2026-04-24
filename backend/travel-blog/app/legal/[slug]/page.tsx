import { notFound } from 'next/navigation';
import Link from 'next/link';
import { marked } from 'marked';
import type { Metadata } from 'next';
import {
  LEGAL_DOCS,
  addHeadingIds,
  extractH2Headings,
  getLegalDoc,
  readLegalMarkdown,
} from '@/lib/legal';
import LegalTableOfContents from '@/components/LegalTableOfContents';

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return LEGAL_DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = getLegalDoc(slug);
  if (!doc) return { title: 'Not found' };
  return {
    title: `${doc.title} — Originfacts`,
    description: doc.description,
  };
}

export default async function LegalPage({ params }: Props) {
  const { slug } = await params;
  const doc = getLegalDoc(slug);
  if (!doc) notFound();

  const md = await readLegalMarkdown(slug);
  if (!md) notFound();

  const headings = extractH2Headings(md);
  const rawHtml = await marked.parse(md, { async: true });
  const html = addHeadingIds(rawHtml);

  return (
    <article
      id="top"
      className="mx-auto max-w-7xl px-6 py-16"
      data-testid={`legal-page-${slug}`}
    >
      {/* Header */}
      <header className="max-w-3xl">
        <nav className="text-xs uppercase tracking-widest text-forest-900/60">
          <Link href="/legal" className="hover:text-forest-900">
            Legal
          </Link>
          <span className="mx-2 text-forest-900/30">/</span>
          <span className="text-forest-900/80">{doc.title}</span>
        </nav>
        <h1 className="editorial-h mt-6 text-3xl font-bold leading-tight text-forest-900 sm:text-4xl">
          {doc.title}
        </h1>
        <p className="mt-3 text-sm text-forest-900/60">{doc.description}</p>
      </header>

      {/* Mobile ToC — collapsible, shown only below lg */}
      {headings.length > 0 && (
        <details className="mt-8 rounded-lg border border-forest-900/10 bg-paper p-4 lg:hidden">
          <summary className="cursor-pointer select-none font-urbanist text-sm font-bold text-forest-900">
            On this page · {headings.length} section{headings.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-4 space-y-2">
            {headings.map((h) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  className="block text-sm text-forest-700 hover:underline"
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Desktop: ToC left, content right with a soft divider */}
      <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] lg:gap-20">
        <aside className="hidden lg:block">
          <LegalTableOfContents headings={headings} />
        </aside>

        <div
          className="prose-article max-w-none"
          data-testid="legal-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      {/* Other legal pages */}
      <div className="mt-20 max-w-3xl border-t border-forest-900/10 pt-8">
        <h3 className="editorial-h text-sm uppercase tracking-widest text-forest-800/70">
          Other legal pages
        </h3>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
          {LEGAL_DOCS.filter((d) => d.slug !== slug).map((d) => (
            <li key={d.slug}>
              <Link
                href={`/legal/${d.slug}`}
                className="text-sm text-forest-700 hover:underline"
              >
                {d.title}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
