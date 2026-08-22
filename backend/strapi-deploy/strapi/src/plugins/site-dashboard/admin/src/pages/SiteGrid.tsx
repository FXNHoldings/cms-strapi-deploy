import { useEffect, useState } from 'react';
import {
  Alert, Badge, Box, Button, Divider, Flex, Grid, Loader, Main, Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { Link } from 'react-router-dom';
import { fmtDate, fmtMoney, orderedRoles, type Site } from '../shared';

/**
 * Every property we publish, one card each.
 *
 * Read-only: the counts are derived live from the database and "Visit" is a
 * plain link. Nothing here writes, deploys or spends.
 */

const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <Flex direction="column" alignItems="flex-start" gap={1}>
    <Typography variant="beta">{value}</Typography>
    <Typography variant="pi" textColor="neutral600">{label}</Typography>
  </Flex>
);

const SiteCard = ({ site }: { site: Site }) => {
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

        {site.offers && (
          <Flex justifyContent="space-between" alignItems="center" gap={2}>
            <Typography variant="pi" textColor="neutral700">offers</Typography>
            <Flex gap={2} alignItems="center">
              <Typography variant="pi" textColor="neutral600">
                {site.offers.active} active
                {site.offers.broken > 0 ? ` · ${site.offers.broken} broken` : ''}
                {site.offers.stale > 0 ? ` · ${site.offers.stale} stale` : ''}
              </Typography>
              {site.offers.everChecked === 0 && (
                <Badge textColor="neutral600" backgroundColor="neutral150">never checked</Badge>
              )}
            </Flex>
          </Flex>
        )}

        {site.clicks && (
          <Flex gap={7} alignItems="flex-start">
            <Stat label={`clicks · ${site.clicks.windowDays}d`} value={site.clicks.clicks} />
            <Stat label="est. value" value={fmtMoney(site.clicks.estimatedValue)} />
          </Flex>
        )}

        <Flex direction="column" alignItems="stretch" gap={1}>
          {orderedRoles(site.roles).map(([role, data]) => (
            <Flex key={role} justifyContent="space-between" alignItems="center" gap={2}>
              <Typography variant="pi" textColor="neutral700">{role}</Typography>
              <Typography variant="pi" textColor="neutral600">
                {data.published} published{data.drafts > 0 ? ` · ${data.drafts} draft` : ''}
              </Typography>
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
            <Button variant="secondary" size="S" tag={Link} to={site.slug}>Manage</Button>
            <Button
              variant="tertiary"
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

const SiteGrid = () => {
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

export { SiteGrid };
export default SiteGrid;
