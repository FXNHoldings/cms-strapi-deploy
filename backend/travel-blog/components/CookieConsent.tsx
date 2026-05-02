'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const STORAGE_KEY = 'originfacts.consent.v1';

type ConsentCategory = 'essential' | 'analytics' | 'marketing';

type ConsentState = {
  version: 1;
  decidedAt: string;
  categories: Record<ConsentCategory, boolean>;
};

type View = 'banner' | 'settings';

const ALL_OFF: ConsentState['categories'] = { essential: true, analytics: false, marketing: false };
const ALL_ON: ConsentState['categories'] = { essential: true, analytics: true, marketing: true };

function readStoredConsent(): ConsentState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConsentState;
    if (parsed?.version === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

function persistConsent(categories: ConsentState['categories']) {
  const payload: ConsentState = {
    version: 1,
    decidedAt: new Date().toISOString(),
    categories,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* private mode / disabled storage — fall through silently */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('originfacts:consent', { detail: payload }));
  }
}

export default function CookieConsent() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('banner');
  const [categories, setCategories] = useState<ConsentState['categories']>(ALL_OFF);

  useEffect(() => {
    const existing = readStoredConsent();
    if (!existing) {
      setOpen(true);
      setView('banner');
    } else {
      setCategories(existing.categories);
    }

    const onReopen = () => {
      const cur = readStoredConsent();
      if (cur) setCategories(cur.categories);
      setView('settings');
      setOpen(true);
    };
    window.addEventListener('originfacts:consent:reopen', onReopen);
    return () => window.removeEventListener('originfacts:consent:reopen', onReopen);
  }, []);

  if (!open) return null;

  const acceptAll = () => {
    persistConsent(ALL_ON);
    setCategories(ALL_ON);
    setOpen(false);
  };
  const rejectAll = () => {
    persistConsent(ALL_OFF);
    setCategories(ALL_OFF);
    setOpen(false);
  };
  const saveChoices = () => {
    const next = { ...categories, essential: true };
    persistConsent(next);
    setOpen(false);
  };
  const toggle = (key: ConsentCategory) => {
    if (key === 'essential') return;
    setCategories((c) => ({ ...c, [key]: !c[key] }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cookie-consent-title"
      className="fixed inset-x-0 bottom-0 z-[100] px-4 pb-4 sm:px-6 sm:pb-6"
      data-testid="cookie-consent"
    >
      <div className="mx-auto max-w-4xl rounded-2xl border border-forest-900/15 bg-paper p-5 shadow-2xl shadow-forest-900/15 sm:p-6">
        {view === 'banner' ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
            <div className="flex-1 text-sm text-forest-900">
              <p id="cookie-consent-title" className="font-semibold">We use cookies</p>
              <p className="mt-1 text-forest-900/75">
                Originfacts uses essential cookies to run the site. With your permission we may also use cookies for analytics and personalised advertising.
                Read our <Link href="/legal/cookies" className="underline hover:text-primary-emphasis">Cookie Policy</Link> for details.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <button
                type="button"
                onClick={() => setView('settings')}
                className="inline-flex h-10 items-center rounded-full border border-forest-900/20 bg-white px-4 text-sm font-medium text-forest-900 transition hover:border-forest-900/40"
                data-testid="cookie-consent-settings"
              >
                Settings
              </button>
              <button
                type="button"
                onClick={rejectAll}
                className="inline-flex h-10 items-center rounded-full border border-forest-900/20 bg-white px-4 text-sm font-medium text-forest-900 transition hover:border-forest-900/40"
                data-testid="cookie-consent-reject"
              >
                Reject all
              </button>
              <button
                type="button"
                onClick={acceptAll}
                className="inline-flex h-10 items-center rounded-full bg-primary-emphasis px-4 text-sm font-semibold text-white transition hover:bg-primary-highlight"
                data-testid="cookie-consent-accept"
              >
                Accept all
              </button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-forest-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p id="cookie-consent-title" className="font-semibold">Cookie settings</p>
                <p className="mt-1 text-forest-900/75">
                  Choose which categories of cookies you allow. You can change these any time.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setView('banner')}
                className="text-xs uppercase tracking-widest text-forest-900/60 hover:text-forest-900"
                aria-label="Back"
              >
                Back
              </button>
            </div>

            <ul className="mt-4 space-y-3">
              <li className="flex items-start justify-between gap-4 rounded-xl border border-forest-900/10 bg-white p-3">
                <div>
                  <p className="font-medium">Essential</p>
                  <p className="mt-1 text-forest-900/70">Required for the site to function (security, navigation, consent storage). Always on.</p>
                </div>
                <input
                  type="checkbox"
                  checked
                  disabled
                  aria-label="Essential cookies (required)"
                  className="mt-1 h-4 w-4 accent-primary-emphasis"
                />
              </li>
              <li className="flex items-start justify-between gap-4 rounded-xl border border-forest-900/10 bg-white p-3">
                <div>
                  <p className="font-medium">Analytics</p>
                  <p className="mt-1 text-forest-900/70">Help us understand how readers use the site so we can improve content and navigation.</p>
                </div>
                <input
                  type="checkbox"
                  checked={categories.analytics}
                  onChange={() => toggle('analytics')}
                  aria-label="Analytics cookies"
                  className="mt-1 h-4 w-4 accent-primary-emphasis"
                  data-testid="cookie-consent-analytics"
                />
              </li>
              <li className="flex items-start justify-between gap-4 rounded-xl border border-forest-900/10 bg-white p-3">
                <div>
                  <p className="font-medium">Advertising / Personalisation</p>
                  <p className="mt-1 text-forest-900/70">Used by ad partners to show more relevant advertising and measure performance.</p>
                </div>
                <input
                  type="checkbox"
                  checked={categories.marketing}
                  onChange={() => toggle('marketing')}
                  aria-label="Advertising cookies"
                  className="mt-1 h-4 w-4 accent-primary-emphasis"
                  data-testid="cookie-consent-marketing"
                />
              </li>
            </ul>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={rejectAll}
                className="inline-flex h-10 items-center rounded-full border border-forest-900/20 bg-white px-4 text-sm font-medium text-forest-900 transition hover:border-forest-900/40"
              >
                Reject all
              </button>
              <button
                type="button"
                onClick={saveChoices}
                className="inline-flex h-10 items-center rounded-full bg-primary-emphasis px-4 text-sm font-semibold text-white transition hover:bg-primary-highlight"
                data-testid="cookie-consent-save"
              >
                Save choices
              </button>
              <button
                type="button"
                onClick={acceptAll}
                className="inline-flex h-10 items-center rounded-full bg-forest-900 px-4 text-sm font-semibold text-white transition hover:bg-forest-700"
              >
                Accept all
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Tiny button you can drop in any footer/legal page so users can re-open consent settings. */
export function CookieSettingsButton({ className }: { className?: string }) {
  const cls = className ?? 'hover:text-secondary';
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('originfacts:consent:reopen'));
        }
      }}
      className={cls}
      data-testid="cookie-consent-reopen"
    >
      Cookie settings
    </button>
  );
}
