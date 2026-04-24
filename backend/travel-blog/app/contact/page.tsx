import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Contact Originfacts',
  description:
    'Get in touch about Originfacts — support, privacy, cookies, accessibility, affiliate enquiries, or user content complaints.',
};

const SUBJECTS = [
  'General support',
  'Website issue',
  'Affiliate enquiry',
  'Privacy request',
  'Cookie request',
  'Accessibility feedback',
  'User content complaint',
  'Legal notice',
  'Other',
];

export default function ContactPage() {
  return (
    <article className="mx-auto max-w-7xl px-6 py-16" data-testid="contact-page">
      <header className="max-w-3xl">
        <p className="chip">Contact</p>
        <h1 className="editorial-h mt-5 text-3xl font-bold leading-tight text-forest-900 sm:text-4xl">
          Contact Us
        </h1>
        <p className="mt-3 text-lg font-light text-forest-900/75">
          We're here to help with questions about Originfacts, our website content, affiliate
          links, user content, privacy, accessibility, and general support.
        </p>
      </header>

      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-16">
        {/* Left — contact info */}
        <aside className="space-y-10">
          <div>
            <h2 className="editorial-h text-sm uppercase tracking-widest text-forest-800/70">
              Email
            </h2>
            <a
              href="mailto:contact@originfacts.com"
              className="mt-2 block font-urbanist text-xl font-bold text-forest-900 hover:text-forest-700"
            >
              contact@originfacts.com
            </a>
            <p className="mt-2 text-sm font-light text-forest-900/70">
              We aim to review messages within a reasonable time.
            </p>
          </div>

          <div>
            <h2 className="editorial-h text-sm uppercase tracking-widest text-forest-800/70">
              Phone
            </h2>
            <a
              href="tel:+447413408585"
              className="mt-2 block font-urbanist text-xl font-bold text-forest-900 hover:text-forest-700"
            >
              +44 7413 408585
            </a>
          </div>

          <div>
            <h2 className="editorial-h text-sm uppercase tracking-widest text-forest-800/70">
              Office
            </h2>
            <address className="mt-2 text-base not-italic leading-relaxed text-forest-900">
              FXN HOLDINGS LIMITED
              <br />
              61 Bridge Street
              <br />
              Kington, HR5 3DJ
              <br />
              United Kingdom
            </address>
          </div>

          <div className="rounded-lg border border-forest-900/10 bg-forest-50 p-5 text-sm leading-relaxed text-forest-900/80">
            <strong className="font-semibold text-forest-900">Booking issues?</strong> Originfacts
            does not handle bookings, payments, or refunds. If your question is about a ticket,
            hotel, rental, or tour, contact the provider you booked with directly.
          </div>
        </aside>

        {/* Right — form */}
        <form
          className="rounded-lg border border-forest-900/10 bg-paper p-6 shadow-sm sm:p-8"
          data-testid="contact-form"
          aria-describedby="contact-form-note"
        >
          <h2 className="editorial-h text-xl font-bold text-forest-900 sm:text-2xl">
            Send us a message
          </h2>
          <p id="contact-form-note" className="mt-1 text-sm font-light text-forest-900/70">
            Please don't send sensitive information (passport numbers, payment details, etc.)
            through this form.
          </p>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <Field label="Name" htmlFor="contact-name">
              <input
                id="contact-name"
                name="name"
                type="text"
                autoComplete="name"
                required
                className={inputClass}
              />
            </Field>

            <Field label="Email" htmlFor="contact-email">
              <input
                id="contact-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className={inputClass}
              />
            </Field>

            <Field label="Subject" htmlFor="contact-subject" className="sm:col-span-2">
              <select id="contact-subject" name="subject" required className={`${inputClass} pr-8`}>
                <option value="" disabled hidden>
                  Select a topic…
                </option>
                {SUBJECTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Page URL (optional)" htmlFor="contact-url" className="sm:col-span-2">
              <input
                id="contact-url"
                name="pageUrl"
                type="url"
                placeholder="https://www.originfacts.com/…"
                className={inputClass}
              />
            </Field>

            <Field label="Message" htmlFor="contact-message" className="sm:col-span-2">
              <textarea
                id="contact-message"
                name="message"
                rows={6}
                required
                className={`${inputClass} resize-y`}
              />
            </Field>
          </div>

          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-forest-900/60">
              By submitting, you agree to our{' '}
              <a href="/legal/privacy" className="underline hover:text-forest-900">
                Privacy Policy
              </a>
              .
            </p>
            <button
              type="submit"
              disabled
              className="inline-flex items-center justify-center rounded-lg bg-forest-900 px-6 py-3 font-urbanist text-sm font-bold uppercase tracking-wider text-sand-100 transition hover:bg-forest-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Send message
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */

const inputClass =
  'w-full rounded-lg border border-forest-900/15 bg-white px-4 py-3 text-base text-forest-900 placeholder:text-forest-900/40 focus:border-forest-700 focus:outline-none focus:ring-2 focus:ring-forest-800/20';

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={`block ${className ?? ''}`}>
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-forest-800/70">
        {label}
      </span>
      {children}
    </label>
  );
}
