import fs from 'fs/promises';
import path from 'path';

export type LegalDoc = {
  slug: string;
  file: string;
  title: string;
  description: string;
};

export const LEGAL_DOCS: LegalDoc[] = [
  {
    slug: 'terms',
    file: 'terms.md',
    title: 'Terms of Use',
    description: 'Your rights and responsibilities when using Originfacts.',
  },
  {
    slug: 'privacy',
    file: 'privacy.md',
    title: 'Privacy Policy',
    description: 'How we collect, use, share, and protect personal information.',
  },
  {
    slug: 'cookies',
    file: 'cookies.md',
    title: 'Cookie Policy',
    description: 'Cookies and similar technologies we use, and how to manage them.',
  },
  {
    slug: 'affiliate-disclosure',
    file: 'affiliate-disclosure.md',
    title: 'Affiliate Disclosure',
    description: 'How we earn affiliate commissions and what that means for you.',
  },
  {
    slug: 'disclaimer',
    file: 'disclaimer.md',
    title: 'Disclaimer',
    description: 'General information only — not legal, medical, or travel advice.',
  },
  {
    slug: 'contact',
    file: 'contact.md',
    title: 'Legal Notice',
    description: 'Company details, contact channels, and legal-notice routing.',
  },
  {
    slug: 'accessibility',
    file: 'accessibility.md',
    title: 'Accessibility',
    description: 'Our WCAG 2.2 AA commitment, known limits, and how to give feedback.',
  },
];

export function getLegalDoc(slug: string): LegalDoc | undefined {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}

export async function readLegalMarkdown(slug: string): Promise<string | null> {
  const doc = getLegalDoc(slug);
  if (!doc) return null;
  const filePath = path.join(process.cwd(), 'content', 'legal', doc.file);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Strip the first H1 — it becomes the page heading rendered by the template
    return raw.replace(/^#\s+.+\n+/, '').trimStart();
  } catch {
    return null;
  }
}

export type LegalHeading = { id: string; text: string };

export function slugifyHeading(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Parse h2 headings from markdown source (used server-side for the ToC). */
export function extractH2Headings(markdown: string): LegalHeading[] {
  const out: LegalHeading[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      const text = m[1].trim();
      out.push({ id: slugifyHeading(text), text });
    }
  }
  return out;
}

/** Add matching id="slug" attributes to <h2> tags in rendered HTML. */
export function addHeadingIds(html: string): string {
  return html.replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner) => {
    const plain = inner.replace(/<[^>]+>/g, '').trim();
    const id = slugifyHeading(plain);
    return `<h2 id="${id}">${inner}</h2>`;
  });
}
