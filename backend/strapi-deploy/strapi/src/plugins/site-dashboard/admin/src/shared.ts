/** Types and helpers shared by the site grid and the per-site view. */

export type Source = {
  uid: string | null;
  filter: Record<string, string> | null;
  total?: number;
  published?: number;
  drafts?: number;
  lastPublishedAt?: string | null;
  error?: string;
};

export type Role = {
  total: number;
  published: number;
  drafts: number;
  lastPublishedAt: string | null;
  sources: Source[];
};

export type RecentPost = {
  uid: string;
  documentId: string;
  title: string;
  updatedAt: string | null;
  publishedAt: string | null;
};

export type ClickStats = {
  windowDays: number;
  clicks: number;
  /** From the merchant's own EPC, so an indicator — never revenue. */
  estimatedValue: number | null;
};

export type OfferHealth = {
  total: number;
  active: number;
  /** expired + error: destinations that no longer resolve. */
  broken: number;
  stale: number;
  /** How many have ever been link-checked — 0 means the number below is untested. */
  everChecked: number;
};

export type PopulatorStats = {
  total: number;
  /** Armed rules. A populator does nothing until someone enables it. */
  enabled: number;
  queuedTopics: number;
};

export type Site = {
  documentId: string;
  name: string;
  slug: string;
  domain: string;
  niche: string | null;
  country: string | null;
  currency: string | null;
  siteStatus: string | null;
  repoPath: string | null;
  deployCommand: string | null;
  gaMeasurementId: string | null;
  thumbnailUrl: string | null;
  isPublished: boolean;
  roles: Record<string, Role>;
  clicks: ClickStats | null;
  offers: OfferHealth | null;
  populators: PopulatorStats | null;
  warnings: string[];
  recentPosts?: RecentPost[];
};

/** Estimated click value. Always rendered with a qualifier — it is not revenue. */
export const fmtMoney = (value: number | null, currency = 'USD') => {
  if (value == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
};

/* Posts lead — it is the number anyone opens this page for. The rest follow in
   a stable order so cards stay comparable side by side. */
const ROLE_ORDER = ['posts', 'categories', 'authors', 'comments', 'menus', 'tags'];

export const orderedRoles = (roles: Record<string, Role>) =>
  Object.entries(roles).sort(([a], [b]) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

export const fmtDate = (iso: string | null) => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
};

/**
 * Content Manager URL for a source, carrying its filter.
 *
 * The filter is the point. nxtsmart.homes and nxtsmarthome.com.au share
 * nxtsmart-post, split by that type's own `site` enum — an unfiltered link
 * opens a list mixing both and invites editing the wrong site's post.
 */
export const manageUrl = (source: Source) => {
  if (!source.uid) return null;
  const base = `/admin/content-manager/collection-types/${source.uid}`;
  if (!source.filter) return base;
  const params = Object.entries(source.filter)
    .map(([field, value], i) => `filters[$and][${i}][${field}][$eq]=${encodeURIComponent(value)}`)
    .join('&');
  return `${base}?${params}`;
};

/** The plugins that already exist, surfaced per site rather than hunted for in the sidebar. */
export const TOOLS = [
  { id: 'ai-writer', label: 'AI Writer', blurb: 'Draft a post for this site' },
  { id: 'content-jobs', label: 'Content Jobs', blurb: 'Run the sourcing and post generators' },
  { id: 'commerce-product-finder', label: 'Product Finder', blurb: 'Find and attach catalogue products' },
  { id: 'bulk-import', label: 'Bulk Import', blurb: 'Import content in bulk' },
];
