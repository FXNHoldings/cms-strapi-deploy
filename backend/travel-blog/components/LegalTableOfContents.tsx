'use client';

import { useEffect, useState } from 'react';
import type { LegalHeading } from '@/lib/legal';

export default function LegalTableOfContents({ headings }: { headings: LegalHeading[] }) {
  const [active, setActive] = useState<string>(headings[0]?.id ?? '');

  useEffect(() => {
    if (headings.length === 0) return;

    // Observer fires when a section crosses the "trigger zone" near the top
    // of the viewport. The -100px top / -65% bottom creates a narrow band
    // near the upper third of the screen; whichever h2 is inside it is active.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        setActive(visible[0].target.id);
      },
      { rootMargin: '-100px 0px -65% 0px', threshold: 0 },
    );

    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <div className="sticky top-24">
      <nav
        aria-label="Table of contents"
        className="max-h-[calc(100vh-8rem)] overflow-y-auto pr-2"
      >
        <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-forest-900/50">
          On this page
        </div>
        <ul className="mt-5 space-y-1">
          {headings.map((h) => {
            const isActive = active === h.id;
            return (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  className={`block border-l-2 py-1.5 pl-4 text-sm leading-snug transition-colors ${
                    isActive
                      ? 'border-forest-800 font-semibold text-forest-900'
                      : 'border-transparent text-forest-900/55 hover:border-forest-900/25 hover:text-forest-900'
                  }`}
                  data-active={isActive ? 'true' : undefined}
                >
                  {h.text}
                </a>
              </li>
            );
          })}
        </ul>
        <a
          href="#top"
          className="mt-8 inline-flex items-center gap-1.5 text-xs font-medium text-forest-700 hover:text-forest-900 hover:underline"
        >
          <span aria-hidden>↑</span> Back to top
        </a>
      </nav>
    </div>
  );
}
