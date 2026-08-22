import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Box, Button, EmptyStateLayout, Flex, Loader, Main, Searchbar,
  SingleSelect, SingleSelectOption, Switch, Table, Tbody, Td, Th, Thead, Tr, Typography,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { fmtDate, type Role, type Site } from '../shared';

/**
 * One role of one site, listed.
 *
 * The publish switch is the only thing on this page that writes, and it is
 * here rather than in the Content Manager because deciding what is live is the
 * job you come to a site dashboard to do. Everything destructive — deleting,
 * editing fields — links out to the Content Manager instead, which already has
 * the confirmations and the validation.
 *
 * Row actions carry the source uid, because a role can be served by more than
 * one collection and the two rows either side of it may live in different ones.
 */

type Item = {
  uid: string;
  documentId: string;
  title: string;
  slug: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
};

type Listing = {
  role: string;
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  multiSource: boolean;
};

/* Only tools that exist. A rail advertising a Category Builder that has not
   been built is worse than a shorter rail. */
const TOOLS_FOR: Record<string, { id: string; label: string }[]> = {
  posts: [
    { id: 'ai-writer', label: 'Article Writer' },
    { id: 'content-jobs', label: 'Content Jobs' },
  ],
  products: [
    { id: 'commerce-product-finder', label: 'Product Finder' },
    { id: 'bulk-import', label: 'Bulk Import' },
  ],
};

const RailLink = ({ to, label, count, active }: { to: string; label: string; count?: number; active: boolean }) => (
  <Box
    tag={Link}
    to={to}
    display="block"
    padding={3}
    hasRadius
    background={active ? 'primary100' : 'neutral0'}
    style={{ textDecoration: 'none' }}
  >
    <Flex justifyContent="space-between" alignItems="center" gap={2}>
      <Typography variant="omega" textColor={active ? 'primary700' : 'neutral800'} fontWeight={active ? 'bold' : 'regular'}>
        {label}
      </Typography>
      {count != null && (
        <Badge textColor="neutral600" backgroundColor="neutral150">{count}</Badge>
      )}
    </Flex>
  </Box>
);

const SiteContent = () => {
  const { slug, role = 'posts' } = useParams();
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [params, setParams] = useSearchParams();

  const page = Math.max(1, Number(params.get('page') || 1));
  const pageSize = Number(params.get('pageSize') || 10);
  const q = params.get('q') ?? '';

  const [site, setSite] = useState<Site | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState(q);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await get(`/site-dashboard/sites/${slug}`);
        setSite(data.site ?? null);
      } catch {
        /* the listing below reports its own failure; a missing rail is survivable */
      }
    })();
  }, [get, slug]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...(q ? { q } : {}) });
      const { data } = await get(`/site-dashboard/sites/${slug}/content/${role}?${search}`);
      setListing(data);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Could not load that list.');
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [get, slug, role, page, pageSize, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setDraft(q); }, [q]);

  const setParam = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const togglePublish = async (item: Item, next: boolean) => {
    setBusy(item.documentId);
    try {
      await put(`/site-dashboard/sites/${slug}/content/${role}/publish`, {
        uid: item.uid,
        documentId: item.documentId,
        published: next,
      });
      toggleNotification({ type: 'success', message: next ? 'Published.' : 'Unpublished — it is a draft again.' });
      await load();
    } catch (e: any) {
      toggleNotification({
        type: 'danger',
        message: e?.response?.data?.error ?? e?.message ?? 'Could not change that.',
      });
    } finally {
      setBusy(null);
    }
  };

  const roles = site?.roles ?? ({} as Record<string, Role>);
  const tools = TOOLS_FOR[role] ?? [];
  const from = listing ? (listing.page - 1) * listing.pageSize + 1 : 0;
  const to = listing ? Math.min(listing.total, listing.page * listing.pageSize) : 0;

  return (
    <Main>
      <Box padding={8}>
        <Flex justifyContent="space-between" alignItems="flex-start" gap={4} paddingBottom={6}>
          <Box>
            <Flex gap={2} alignItems="center" paddingBottom={1}>
              <Button variant="tertiary" size="S" tag={Link} to="../..">← All sites</Button>
              <Typography variant="pi" textColor="neutral500">
                {site?.name ?? slug} · {role}
              </Typography>
            </Flex>
            <Typography variant="alpha" style={{ textTransform: 'capitalize' }}>{role}</Typography>
            <Box paddingTop={1}>
              <Typography variant="epsilon" textColor="neutral600">
                {loading ? 'Counting…' : `${listing?.total ?? 0} on ${site?.name ?? slug}`}
              </Typography>
            </Box>
          </Box>
          <Flex gap={2}>
            {tools.map((t) => (
              <Button key={t.id} variant="secondary" size="S" tag="a" href={`/admin/plugins/${t.id}`}>
                {t.label}
              </Button>
            ))}
          </Flex>
        </Flex>

        {error && (
          <Box paddingBottom={4}>
            <Alert variant="danger" title="Problem" onClose={() => setError('')}>{error}</Alert>
          </Box>
        )}

        <Flex alignItems="flex-start" gap={6}>
          {/* Left rail: the site's own roles, from its registry — not a fixed list */}
          <Box style={{ width: 220, flexShrink: 0 }}>
            <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150" padding={3}>
              <Flex direction="column" alignItems="stretch" gap={1}>
                {Object.entries(roles).map(([name, data]) => (
                  <RailLink
                    key={name}
                    to={`../${name}`}
                    label={name}
                    count={data.total}
                    active={name === role}
                  />
                ))}
              </Flex>
            </Box>
            <Box paddingTop={4}>
              <Box paddingLeft={3} paddingBottom={2}>
                <Typography variant="sigma" textColor="neutral600">AI Tools</Typography>
              </Box>
              <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150" padding={3}>
                <Flex direction="column" alignItems="stretch" gap={1}>
                  {tools.length === 0 && (
                    <Box padding={2}>
                      <Typography variant="pi" textColor="neutral500">Nothing for {role} yet.</Typography>
                    </Box>
                  )}
                  {tools.map((t) => (
                    <Box key={t.id} tag="a" href={`/admin/plugins/${t.id}`} display="block" padding={3} hasRadius style={{ textDecoration: 'none' }}>
                      <Typography variant="omega" textColor="neutral800">{t.label}</Typography>
                    </Box>
                  ))}
                  <Box tag="a" href="/admin/content-manager/collection-types/api::content-populator.content-populator" display="block" padding={3} hasRadius style={{ textDecoration: 'none' }}>
                    <Typography variant="omega" textColor="neutral800">Auto Populators</Typography>
                  </Box>
                </Flex>
              </Box>
            </Box>
          </Box>

          <Box style={{ flex: 1, minWidth: 0 }}>
            <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150">
              <Box padding={4}>
                <Flex justifyContent="space-between" gap={3}>
                  <Box style={{ maxWidth: 320, width: '100%' }}>
                    <Searchbar
                      name="search"
                      value={draft}
                      onChange={(e: any) => setDraft(e.target.value)}
                      onKeyDown={(e: any) => { if (e.key === 'Enter') setParam({ q: draft, page: '1' }); }}
                      onClear={() => { setDraft(''); setParam({ q: null, page: '1' }); }}
                      placeholder="Search by title"
                    >
                      Search
                    </Searchbar>
                  </Box>
                  {listing?.multiSource && (
                    <Badge textColor="neutral600" backgroundColor="neutral150">
                      merged from 2 collections
                    </Badge>
                  )}
                </Flex>
              </Box>

              {loading ? (
                <Flex justifyContent="center" padding={10}><Loader>Loading</Loader></Flex>
              ) : !listing || listing.items.length === 0 ? (
                <Box padding={8}>
                  <EmptyStateLayout
                    content={q ? `Nothing matching “${q}”.` : `No ${role} on this site yet.`}
                    action={q ? <Button variant="tertiary" onClick={() => { setDraft(''); setParam({ q: null, page: '1' }); }}>Clear search</Button> : undefined}
                  />
                </Box>
              ) : (
                <Table colCount={4} rowCount={listing.items.length}>
                  <Thead>
                    <Tr>
                      <Th><Typography variant="sigma">Title</Typography></Th>
                      <Th><Typography variant="sigma">Published</Typography></Th>
                      <Th><Typography variant="sigma">Publish date</Typography></Th>
                      <Th><Typography variant="sigma">Actions</Typography></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {listing.items.map((item) => (
                      <Tr key={`${item.uid}-${item.documentId}`}>
                        <Td>
                          <Typography textColor="neutral800" ellipsis>{item.title}</Typography>
                        </Td>
                        <Td>
                          <Switch
                            checked={Boolean(item.publishedAt)}
                            disabled={busy === item.documentId}
                            onCheckedChange={(next: boolean) => togglePublish(item, next)}
                            visibleLabels
                            onLabel="Live"
                            offLabel="Draft"
                          />
                        </Td>
                        <Td>
                          {/* Published date when live, last edit when not - a
                              draft has no publish date to show. */}
                          <Typography variant="pi" textColor="neutral600">
                            {item.publishedAt
                              ? fmtDate(item.publishedAt)
                              : `edited ${fmtDate(item.updatedAt)}`}
                          </Typography>
                        </Td>
                        <Td>
                          <Flex gap={2}>
                            <Button
                              variant="tertiary"
                              size="S"
                              tag="a"
                              href={`/admin/content-manager/collection-types/${item.uid}/${item.documentId}`}
                            >
                              Edit
                            </Button>
                            {site?.domain && item.slug && (
                              <Button
                                variant="tertiary"
                                size="S"
                                tag="a"
                                href={`https://${site.domain}/${item.slug}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                View
                              </Button>
                            )}
                          </Flex>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}

              {listing && listing.total > 0 && (
                <Box padding={4}>
                  <Flex justifyContent="space-between" alignItems="center" gap={3}>
                    <Typography variant="pi" textColor="neutral600">
                      Showing {from} to {to} of {listing.total}
                    </Typography>
                    <Flex gap={3} alignItems="center">
                      <Box style={{ width: 110 }}>
                        <SingleSelect
                          size="S"
                          value={String(listing.pageSize)}
                          onChange={(v: any) => setParam({ pageSize: String(v), page: '1' })}
                          aria-label="Per page"
                        >
                          {['10', '20', '50', '100'].map((n) => (
                            <SingleSelectOption key={n} value={n}>{n} per page</SingleSelectOption>
                          ))}
                        </SingleSelect>
                      </Box>
                      <Flex gap={1} alignItems="center">
                        <Button
                          variant="tertiary"
                          size="S"
                          disabled={listing.page <= 1}
                          onClick={() => setParam({ page: String(listing.page - 1) })}
                        >
                          Previous
                        </Button>
                        <Box paddingLeft={2} paddingRight={2}>
                          <Typography variant="pi" textColor="neutral600">
                            {listing.page} / {listing.pageCount}
                          </Typography>
                        </Box>
                        <Button
                          variant="tertiary"
                          size="S"
                          disabled={listing.page >= listing.pageCount}
                          onClick={() => setParam({ page: String(listing.page + 1) })}
                        >
                          Next
                        </Button>
                      </Flex>
                    </Flex>
                  </Flex>
                </Box>
              )}
            </Box>
          </Box>
        </Flex>
      </Box>
    </Main>
  );
};

export { SiteContent };
export default SiteContent;
