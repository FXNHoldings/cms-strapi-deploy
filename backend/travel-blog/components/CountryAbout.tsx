'use client';

import { useState } from 'react';

type Section = { heading: string | null; paragraphs: string[] };

export default function CountryAbout({ sections }: { sections: Section[] }) {
  const [expanded, setExpanded] = useState(false);

  if (sections.length === 0) return null;

  const [first, ...rest] = sections;
  const hasMore = rest.length > 0;
  const lastIdx = first.paragraphs.length - 1;

  return (
    <div className="prose-article max-w-none" data-testid="country-about-content">
      {first.heading && (
        <h3 className="font-urbanist text-xl font-bold text-forest-900">{first.heading}</h3>
      )}

      {first.paragraphs.map((p, i) => (
        <p key={i} className={first.heading && i === 0 ? 'mt-3' : ''}>
          {p}
          {!expanded && hasMore && i === lastIdx && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="font-medium text-primary-emphasis hover:text-primary-highlight hover:underline"
                data-testid="country-about-read-more"
                aria-expanded="false"
              >
                Read more
              </button>
            </>
          )}
        </p>
      ))}

      {expanded && hasMore && (
        <>
          {rest.map((s, i) => (
            <SectionBlock key={i} section={s} />
          ))}
          <p className="mt-6">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="font-medium text-primary-emphasis hover:text-primary-highlight hover:underline"
              data-testid="country-about-show-less"
              aria-expanded="true"
            >
              Show less
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function SectionBlock({ section }: { section: Section }) {
  return (
    <div className="mt-8">
      {section.heading && (
        <h3 className="font-urbanist text-xl font-bold text-forest-900">{section.heading}</h3>
      )}
      {section.paragraphs.map((p, i) => (
        <p key={i} className={section.heading ? 'mt-3' : ''}>
          {p}
        </p>
      ))}
    </div>
  );
}
