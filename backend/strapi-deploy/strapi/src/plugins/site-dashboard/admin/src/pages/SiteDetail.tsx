import { useEffect, useState } from 'react';
import {
  Alert, Badge, Box, Button, Divider, Flex, Grid, Loader, Main, Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { Link, useParams } from 'react-router-dom';
import { TOOLS, fmtDate, fmtMoney, manageUrl, orderedRoles, type Site } from '../shared';

/**
 * One property, in detail.
 *
 * Still read-only. The tool tiles link to plugins that already exist rather
 * than reimplementing them, and the reference block records how the site is
 * deployed instead of offering to deploy it — a deploy button in the admin is
 * one misclick away from restarting production.
 */

const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <Flex direction="column" alignItems="flex-start" gap={1}>
    <Typography variant="alpha">{value}</Typography>
    <Typography variant="pi" textColor="neutral600">{label}</Typography>
  </Flex>
);

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150" padding={5} height="100%">
    <Flex direction="column" alignItems="stretch" gap={4} height="100%">
      <Typography variant="delta">{title}</Typography>
      {children}
    </Flex>
  </Box>
);

const SiteDetail = () => {
  const { slug } = useParams();
  const { get } = useFetchClient();
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await get(`/site-dashboard/sites/${slug}`);
        setSite(data.site ?? null);
      } catch (e: any) {
        setError(e?.response?.data?.error ?? e?.message ?? 'Could not load that site.');
      } finally {
        setLoading(false);
      }
    })();
  }, [get, slug]);

  if (loading) {
    return (
      <Main>
        <Flex justifyContent="center" padding={10}><Loader>Loading site</Loader></Flex>
      </Main>
    );
  }

  if (error || !site) {
    return (
      <Main>
        <Box padding={8}>
          <Box paddingBottom={4}>
            <Alert variant="danger" title="Problem">{error || 'Site not found.'}</Alert>
          </Box>
          <Button variant="tertiary" tag={Link} to="..">Back to all sites</Button>
        </Box>
      </Main>
    );
  }

  const posts = site.roles.posts;

  return (
    <Main>
      <Box padding={8}>
        <Box paddingBottom={4}>
          <Button variant="tertiary" size="S" tag={Link} to="..">← All sites</Button>
        </Box>

        <Flex justifyContent="space-between" alignItems="flex-start" gap={4}>
          <Flex direction="column" alignItems="flex-start" gap={1}>
            <Typography variant="alpha">{site.name}</Typography>
            <Typography variant="epsilon" textColor="neutral600">
              {site.domain}
              {site.niche ? ` · ${site.niche}` : ''}
              {site.currency ? ` · ${site.currency}` : ''}
            </Typography>
          </Flex>
          <Flex gap={2}>
            {!site.isPublished && <Badge textColor="warning600" backgroundColor="warning100">draft</Badge>}
            <Badge
              textColor={site.siteStatus === 'active' ? 'success600' : 'neutral600'}
              backgroundColor={site.siteStatus === 'active' ? 'success100' : 'neutral150'}
            >
              {site.siteStatus ?? 'unset'}
            </Badge>
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
        </Flex>

        {site.warnings.length > 0 && (
          <Box paddingTop={4}>
            <Alert variant="warning" title="Worth a look">
              {site.warnings.join(' · ')}
            </Alert>
          </Box>
        )}

        {posts && (
          <Box paddingTop={6} paddingBottom={2}>
            <Flex gap={10} alignItems="flex-start">
              <Stat label="published posts" value={posts.published} />
              <Stat label="drafts" value={posts.drafts} />
              <Stat label="last published" value={fmtDate(posts.lastPublishedAt)} />
              {site.clicks && (
                <>
                  <Stat label={`clicks · last ${site.clicks.windowDays}d`} value={site.clicks.clicks} />
                  <Stat label="estimated value" value={fmtMoney(site.clicks.estimatedValue)} />
                </>
              )}
            </Flex>
            {site.clicks && site.clicks.estimatedValue != null && (
              <Box paddingTop={2}>
                <Typography variant="pi" textColor="neutral500">
                  Estimated from each merchant&apos;s EPC, not from network reporting. Treat it as
                  an indicator of which sites earn, never as revenue.
                </Typography>
              </Box>
            )}
          </Box>
        )}

        <Box paddingTop={6}>
          <Grid.Root gap={5}>
            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Panel title="Content">
                <Flex direction="column" alignItems="stretch" gap={3}>
                  {orderedRoles(site.roles).map(([role, data]) => (
                    <Box key={role}>
                      <Flex justifyContent="space-between" alignItems="center" gap={2}>
                        <Flex direction="column" alignItems="flex-start" gap={0}>
                          <Typography variant="omega">{role}</Typography>
                          <Typography variant="pi" textColor="neutral600">
                            {data.published} published
                            {data.drafts > 0 ? ` · ${data.drafts} draft` : ''}
                          </Typography>
                        </Flex>
                        <Flex gap={2}>
                          {data.sources.map((source, i) =>
                            source.error ? (
                              <Badge key={i} textColor="danger600" backgroundColor="danger100">
                                {source.error}
                              </Badge>
                            ) : manageUrl(source) ? (
                              <Button key={i} variant="tertiary" size="S" tag="a" href={manageUrl(source) as string}>
                                {source.filter ? 'manage (filtered)' : 'manage'}
                              </Button>
                            ) : null,
                          )}
                        </Flex>
                      </Flex>
                      <Box paddingTop={3}><Divider /></Box>
                    </Box>
                  ))}
                </Flex>
              </Panel>
            </Grid.Item>

            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Panel title="Recently edited">
                {site.recentPosts && site.recentPosts.length > 0 ? (
                  <Flex direction="column" alignItems="stretch" gap={2}>
                    {site.recentPosts.map((post) => (
                      <Flex key={`${post.uid}-${post.documentId}`} justifyContent="space-between" alignItems="center" gap={3}>
                        <Box style={{ minWidth: 0 }}>
                          <Typography variant="omega" ellipsis>{post.title}</Typography>
                        </Box>
                        <Flex gap={2} alignItems="center">
                          <Typography variant="pi" textColor="neutral500">{fmtDate(post.updatedAt)}</Typography>
                          {!post.publishedAt && (
                            <Badge textColor="warning600" backgroundColor="warning100">draft</Badge>
                          )}
                          <Button
                            variant="tertiary"
                            size="S"
                            tag="a"
                            href={`/admin/content-manager/collection-types/${post.uid}/${post.documentId}`}
                          >
                            Edit
                          </Button>
                        </Flex>
                      </Flex>
                    ))}
                  </Flex>
                ) : (
                  <Typography variant="pi" textColor="neutral600">Nothing yet.</Typography>
                )}
              </Panel>
            </Grid.Item>

            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Panel title="Tools">
                <Flex direction="column" alignItems="stretch" gap={2}>
                  {TOOLS.map((tool) => (
                    <Flex key={tool.id} justifyContent="space-between" alignItems="center" gap={3}>
                      <Flex direction="column" alignItems="flex-start" gap={0}>
                        <Typography variant="omega">{tool.label}</Typography>
                        <Typography variant="pi" textColor="neutral600">{tool.blurb}</Typography>
                      </Flex>
                      <Button variant="tertiary" size="S" tag="a" href={`/admin/plugins/${tool.id}`}>
                        Open
                      </Button>
                    </Flex>
                  ))}
                </Flex>
              </Panel>
            </Grid.Item>

            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Panel title="Offer health">
                {site.offers ? (
                  <Flex direction="column" alignItems="stretch" gap={3}>
                    <Flex gap={8} alignItems="flex-start">
                      <Stat label="active" value={site.offers.active} />
                      <Stat label="broken" value={site.offers.broken} />
                      <Stat label="stale" value={site.offers.stale} />
                    </Flex>
                    <Typography variant="pi" textColor="neutral500">
                      {site.offers.everChecked === 0
                        ? `None of these ${site.offers.total} offers has been link-checked yet, so "active" means "never tested", not "known good". Run the Check offer links job.`
                        : `${site.offers.everChecked} of ${site.offers.total} link-checked.`}
                    </Typography>
                  </Flex>
                ) : (
                  <Typography variant="pi" textColor="neutral600">
                    No offers reach this site. Offers are attributed through their product&apos;s
                    site relation, and most products carry none.
                  </Typography>
                )}
              </Panel>
            </Grid.Item>

            <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
              <Panel title="Reference">
                <Flex direction="column" alignItems="stretch" gap={3}>
                  {[
                    ['Repo', site.repoPath ?? 'not recorded'],
                    ['Deploy', site.deployCommand ?? 'not recorded'],
                    ['GA4', site.gaMeasurementId ?? 'not recorded'],
                    ['Country', site.country ?? '—'],
                  ].map(([label, value]) => (
                    <Flex key={label} justifyContent="space-between" alignItems="baseline" gap={3}>
                      <Typography variant="pi" textColor="neutral600">{label}</Typography>
                      <Typography variant="pi" textColor="neutral800">{value}</Typography>
                    </Flex>
                  ))}
                  <Typography variant="pi" textColor="neutral500">
                    Recorded for reference. Deploys run on the host, not from here.
                  </Typography>
                </Flex>
              </Panel>
            </Grid.Item>
          </Grid.Root>
        </Box>
      </Box>
    </Main>
  );
};

export { SiteDetail };
export default SiteDetail;
