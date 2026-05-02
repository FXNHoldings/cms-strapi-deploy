'use client';

import { useEffect, useState } from 'react';

type Props = {
  title: string;
  slug: string;
};

const SITE_URL = 'https://www.originfacts.com';

export default function ShareButtons({ title, slug }: Props) {
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState(`${SITE_URL}/articles/${slug}`);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setUrl(window.location.href);
    }
  }, []);

  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);

  const xHref = `https://x.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}&via=realoriginfacts`;
  const facebookHref = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const btn =
    'inline-flex h-9 items-center gap-2 rounded-full border border-forest-900/15 bg-white px-3 text-xs font-medium text-forest-900 transition hover:border-forest-900/30 hover:bg-forest-900/5';

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="share-buttons">
      <span className="text-xs uppercase tracking-widest text-forest-800/70">Share</span>

      <a
        href={xHref}
        target="_blank"
        rel="noopener noreferrer"
        className={btn}
        aria-label="Share on X"
        data-testid="share-x"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.967 6.817H1.677l7.73-8.835L1.255 2.25h6.83l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        X
      </a>

      <a
        href={facebookHref}
        target="_blank"
        rel="noopener noreferrer"
        className={btn}
        aria-label="Share on Facebook"
        data-testid="share-facebook"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
          <path d="M22 12.06C22 6.48 17.52 2 11.94 2 6.36 2 1.88 6.48 1.88 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.78v-2.91h2.54V9.84c0-2.51 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46H15.1c-1.24 0-1.62.77-1.62 1.56v1.87h2.76l-.44 2.91h-2.32V22c4.78-.76 8.52-4.92 8.52-9.94z" />
        </svg>
        Facebook
      </a>

      <button
        type="button"
        onClick={onCopy}
        className={btn}
        aria-label="Copy link"
        data-testid="share-copy"
      >
        {copied ? (
          <>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Copied
          </>
        ) : (
          <>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
              <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
            </svg>
            Copy link
          </>
        )}
      </button>
    </div>
  );
}
