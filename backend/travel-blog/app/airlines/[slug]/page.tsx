import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAirline, mediaUrl, type StrapiAirline } from '@/lib/strapi';
import type { Metadata } from 'next';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const a = await getAirline(slug);
  if (!a) return { title: 'Not found' };
  const desc = a.about?.slice(0, 150) || `${a.name}${a.iataCode ? ` (${a.iataCode})` : ''} — airline profile, base of operations, and contact details.`;
  return { title: a.name, description: desc };
}

export default async function AirlinePage({ params }: Props) {
  const { slug } = await params;
  const airline = await getAirline(slug);
  if (!airline) notFound();

  const logo = mediaUrl(airline.logo ?? null);
  const ageYears = airline.founded ? new Date().getFullYear() - airline.founded : null;

  return (
    <article data-testid={`airline-page-${slug}`}>
      {/* Breadcrumb */}
      <div className="mx-auto max-w-6xl px-6 pt-10">
        <nav className="text-xs uppercase tracking-widest text-forest-900/60">
          <Link href="/airlines" className="hover:text-forest-900">Airlines</Link>
          <span className="mx-2 text-forest-900/30">/</span>
          <span className="text-forest-900/80">{airline.name}</span>
        </nav>
      </div>

      {/* Hero */}
      <header className="mx-auto mt-6 max-w-6xl px-6">
        <div className="flex flex-col gap-6 border-b border-forest-900/10 pb-10 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex h-24 w-24 flex-none items-center justify-center overflow-hidden rounded-[0.3rem] border border-forest-900/10 bg-forest-900/5">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={airline.name} className="h-full w-full object-contain p-2" />
            ) : (
              <span className="font-urbanist text-2xl font-black text-forest-900/60">
                {(airline.iataCode || airline.name).slice(0, 3).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-widest text-forest-900/60">
              {airline.type && <span className="chip">{airline.type}</span>}
              {airline.region && <span>{airline.region}</span>}
              {airline.country && <span>· {airline.country}</span>}
            </div>
            <h1 className="editorial-h mt-3 text-4xl font-black leading-[1.05] text-forest-900 lg:text-6xl">
              {airline.name}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-xs">
              {airline.iataCode && (
                <span className="rounded-[0.3rem] bg-forest-900 px-3 py-1.5 font-bold tracking-wider text-sand-100">
                  IATA · {airline.iataCode}
                </span>
              )}
              {airline.icaoCode && (
                <span className="rounded-[0.3rem] border border-forest-900/20 px-3 py-1.5 font-bold tracking-wider text-forest-900">
                  ICAO · {airline.icaoCode}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* First section — About */}
      {airline.about && (
        <section className="mx-auto mt-14 max-w-3xl px-6" data-testid="airline-about">
          <p className="section-eyebrow">
            <span className="inline-block h-px w-8 bg-forest-800/60" />
            About {airline.name}
          </p>
          <div className="prose-article mt-4">
            {airline.about.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        </section>
      )}

      {/* Second section — 3 columns */}
      <section className="mx-auto mt-16 max-w-6xl px-6 pb-20" data-testid="airline-specs">
        <div className="grid gap-8 md:grid-cols-3">
          <InfoColumn title="Identifiers">
            <InfoRow label="IATA Code" value={airline.iataCode} mono />
            <InfoRow label="ICAO Code" value={airline.icaoCode} mono />
            <InfoRow label="Legal Name" value={airline.legalName} />
            <InfoRow label="Type" value={airline.type} />
          </InfoColumn>

          <InfoColumn title="Base & Operations">
            <InfoRow label="Country" value={airline.country} />
            <InfoRow label="Airport" value={airline.airport} />
            <InfoRow label="City" value={airline.city} />
            <InfoRow label="Region" value={airline.region} />
            <InfoRow
              label="Founded"
              value={
                airline.founded
                  ? `${airline.founded}${ageYears != null ? ` (${ageYears} yr${ageYears === 1 ? '' : 's'})` : ''}`
                  : undefined
              }
            />
          </InfoColumn>

          <InfoColumn title="Additional Data">
            <InfoRow
              label="Logo"
              value={logo ? <span className="text-forest-900/80">Available</span> : <span className="text-forest-900/40">—</span>}
            />
            <InfoRow label="Address" value={airline.address} multiline />
            <InfoRow label="Phone" value={airline.phone} />
            <InfoRow
              label="Website"
              value={
                airline.website ? (
                  <a
                    href={airline.website.startsWith('http') ? airline.website : `https://${airline.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-terracotta-700 underline-offset-2 hover:underline"
                  >
                    {airline.website.replace(/^https?:\/\//, '')}
                  </a>
                ) : undefined
              }
            />
          </InfoColumn>
        </div>
      </section>
    </article>
  );
}

function InfoColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[0.3rem] border border-forest-900/10 bg-forest-900/[0.02] p-6">
      <h3 className="editorial-h text-xs font-bold uppercase tracking-[0.2em] text-forest-900/60">{title}</h3>
      <dl className="mt-5 space-y-4">{children}</dl>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
  multiline = false,
}: {
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-widest text-forest-900/50">{label}</dt>
      <dd
        className={
          'mt-1 text-sm text-forest-900 ' +
          (mono ? 'font-mono font-bold tracking-wider ' : 'font-light ') +
          (multiline ? 'whitespace-pre-wrap ' : '')
        }
      >
        {value ?? <span className="text-forest-900/30">—</span>}
      </dd>
    </div>
  );
}
