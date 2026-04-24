import { marked } from 'marked';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { readPageMarkdown } from '@/lib/pages';

export const metadata: Metadata = {
  title: 'About Originfacts',
  description:
    'Originfacts is a travel information and comparison site — flights, hotels, car rentals, and travel resources in one place.',
};

export default async function AboutPage() {
  const md = await readPageMarkdown('about');
  if (!md) notFound();

  const html = await marked.parse(md, { async: true });

  return (
    <article className="mx-auto max-w-7xl px-6 py-16" data-testid="about-page">
      <header className="max-w-3xl">
        <p className="chip">About</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold leading-tight text-forest-900 sm:text-4xl">
          About Originfacts
        </h1>
        <p className="mt-3 text-lg font-light text-forest-900/75">
          Smarter travel research, all in one place.
        </p>
      </header>
      <div
        className="prose-article mt-10 max-w-none"
        data-testid="about-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}
