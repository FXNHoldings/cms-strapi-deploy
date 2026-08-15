import { useEffect, useState } from 'react';
import {
  Alert, Badge, Box, Button, Divider, Flex, Grid, Loader, Main, Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

/**
 * Sites — one card per property we publish.
 *
 * Read-only on purpose. Everything shown is derived from the commerce-site
 * registry and counted live out of the database, so there is nothing here that
 * can change a site, deploy one, or spend anything.
 *
 * "Manage" deep-links into the Content Manager with the site's own filter
 * already applied. That matters for the two smart-home properties, which share
 * nxtsmart-post between them: without the filter the link would open a list
 * mixing both sites' posts and silently invite editing the wrong one.
 */

type Source = {
  uid: string | null;
  filter: Record<string, string> | null;
  total?: number;
  published?: number;
  drafts?: number;
  lastPublishedAt?: string | null;
  error?: string;
};
type Role = {
  total: number;
  published: number;
  drafts: number;
  lastPublishedAt: string | null;
  sources: Source[];
};
type Site = {
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
  warnings: string[];
};

/* Posts lead the card — it is the number anyone actually opens this page for.
   The rest follow in whatever order the registry lists them. */
const ROLE_ORDER = ['posts', 'categories', 'authors', 'comments', 'menus', 'tags'];

const orderedRoles = (roles: Record<string, Role>) =>
  Object.entries(roles).sort(([a], [b]) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

const fmtDate = (iso: string | null) => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
};

/* Content Manager URL for a source, carrying its filter so the list opens
   scoped to this site rather than to every row of a shared type. */
const manageUrl = (source: Source) => {
  if (!source.uid) return null;
  const base = `/admin/content-manager/collection-types/${source.uid}`;
  if (!source.filter) return base;
  const params = Object.entries(source.filter)
    .map(([field, value], i) => `filters[$and][${i}][${field}][$eq]=${encodeURIComponent(value)}`)
    .join('&');
  return `${base}?${params}`;
};

const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <Flex direction="column" alignItems="flex-start" gap={1}>
    <Typography variant="beta">{value}</Typography>
    <Typography variant="pi" textColor="neutral600">{label}</Typography>
  </Flex>
);

const SiteCard = ({ site }: { site: Site }) => {
  const roles = orderedRoles(site.roles);
  const posts = site.roles.posts;

  return (
    <Box
      background="neutral0"
      hasRadius
      shadow="tableShadow"
      borderColor="neutral150"
      padding={5}
      height="100%"
    >
      <Flex direction="column" alignItems="stretch" gap={4} height="100%">
        <Flex justifyContent="space-between" alignItems="flex-start" gap={2}>
          <Flex direction="column" alignItems="flex-start" gap={1}>
            <Typography variant="delta">{site.name}</Typography>
            <Typography variant="pi" textColor="neutral600">{site.domain}</Typography>
          </Flex>
          <Flex gap={2}>
            {!site.isPublished && (
              <Badge textColor="warning600" backgroundColor="warning100">draft</Badge>
            )}
            <Badge
              textColor={site.siteStatus === 'active' ? 'success600' : 'neutral600'}
              backgroundColor={site.siteStatus === 'active' ? 'success100' : 'neutral150'}
            >
              {site.siteStatus ?? 'unset'}
            </Badge>
          </Flex>
        </Flex>

        <Divider />

        {posts ? (
          <Flex gap={7} alignItems="flex-start">
            <Stat label="published" value={posts.published} />
            <Stat label="drafts" value={posts.drafts} />
            <Stat label="last published" value={fmtDate(posts.lastPublishedAt)} />
          </Flex>
        ) : (
          <Typography variant="pi" textColor="neutral600">
            No posts role in this site&apos;s content map.
          </Typography>
        )}

        <Flex direction="column" alignItems="stretch" gap={2}>
          {roles.map(([role, data]) => (
            <Flex key={role} justifyContent="space-between" alignItems="center" gap={2}>
              <Typography variant="pi" textColor="neutral700">{role}</Typography>
              <Flex gap={2} alignItems="center">
                <Typography variant="pi" textColor="neutral600">
                  {data.published} published{data.drafts > 0 ? ` · ${data.drafts} draft` : ''}
                </Typography>
                {data.sources.map((source, i) =>
                  manageUrl(source) ? (
                    <Button
                      key={`${role}-${i}`}
                      variant="tertiary"
                      size="S"
                      tag="a"
                      href={manageUrl(source) as string}
                    >
                      {data.sources.length > 1 ? `manage ${i + 1}` : 'manage'}
                    </Button>
                  ) : null,
                )}
              </Flex>
            </Flex>
          ))}
        </Flex>

        {site.warnings.length > 0 && (
          <Box background="warning100" hasRadius padding={3}>
            <Flex direction="column" alignItems="flex-start" gap={1}>
              {site.warnings.map((w) => (
                <Typography key={w} variant="pi" textColor="warning700">{w}</Typography>
              ))}
            </Flex>
          </Box>
        )}

        <Box marginTop="auto" paddingTop={2}>
          <Flex justifyContent="space-between" alignItems="center" gap={2}>
            <Typography variant="pi" textColor="neutral500">
              {site.deployCommand ?? 'no deploy command recorded'}
            </Typography>
            <Button
              variant="secondary"
              size="S"
              tag="a"
              href={`https://${site.domain}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Visit
            </Button>
          </Flex>
        </Box>
      </Flex>
    </Box>
  );
};

const App = () => {
  const { get } = useFetchClient();
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await get('/site-dashboard/sites');
        setSites(data.sites ?? []);
      } catch (e: any) {
        setError(e?.response?.data?.error ?? e?.message ?? 'Could not load the site registry.');
      } finally {
        setLoading(false);
      }
    })();
  }, [get]);

  const totalPublished = sites.reduce((n, s) => n + (s.roles.posts?.published ?? 0), 0);

  return (
    <Main>
      <Box padding={8}>
        <Typography variant="alpha">Sites</Typography>
        <Box paddingTop={2} paddingBottom={6}>
          <Typography variant="epsilon" textColor="neutral600">
            {loading
              ? 'Counting content across every property…'
              : `${sites.length} propert${sites.length === 1 ? 'y' : 'ies'} · ${totalPublished} published posts in total`}
          </Typography>
        </Box>

        {error && (
          <Box paddingBottom={4}>
            <Alert variant="danger" title="Problem" onClose={() => setError('')}>{error}</Alert>
          </Box>
        )}

        {loading ? (
          <Flex justifyContent="center" padding={10}><Loader>Loading sites</Loader></Flex>
        ) : sites.length === 0 ? (
          <Typography textColor="neutral600">
            No sites in the registry yet. Add rows to Commerce · Site, or run
            scripts/seed-commerce-sites.mjs.
          </Typography>
        ) : (
          <Grid.Root gap={5}>
            {sites.map((site) => (
              <Grid.Item key={site.documentId} col={4} s={12} direction="column" alignItems="stretch">
                <SiteCard site={site} />
              </Grid.Item>
            ))}
          </Grid.Root>
        )}
      </Box>
    </Main>
  );
};

export { App };
export default App;
