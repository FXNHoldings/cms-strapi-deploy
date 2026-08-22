import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Badge, Box, Button, EmptyStateLayout, Flex, Loader, Main, Searchbar,
  SingleSelect, SingleSelectOption, Switch, Table, Tbody, Td, Th, Thead, Tr, Typography,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { fmtDate, type Site } from '../shared';

/**
 * The catalogue for one site: products, and the categories, brands and offers
 * those products pull in.
 *
 * Unlike posts, none of this comes from the site's contentTypes registry - the
 * commerce types are shared across every property, and belonging is the
 * product's `site` relation. Categories and brands are derived from it rather
 * than listed, so renaming one cannot silently drop it from a site.
 */

type Item = {
  documentId: string;
  name: string;
  slug: string | null;
  status: string | null;
  published: boolean;
  updatedAt: string | null;
  uid: string;
};

type Listing = {
  role: string;
  tab: string;
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  canPublish: boolean;
};

const ROLES = ['products', 'categories', 'brands', 'offers'] as const;

/* The hygiene views. Each answers something worth acting on: a product in no
   category cannot be browsed to, one with no offer has nothing to sell. */
const TABS = [
  { id: 'all', label: 'All' },
  { id: 'no-categories', label: 'No categories' },
  { id: 'no-offers', label: 'No offers' },
];

/* Only tools that exist. A rail advertising a Category Builder that has not
   been built is worse than a shorter rail. */
const TOOLS = [
  { id: 'commerce-product-finder', label: 'Product Finder' },
  { id: 'content-jobs', label: 'Product Importer' },
];

const RailLink = ({ to, label, count, active }: { to: string; label: string; count?: number | null; active: boolean }) => (
  <Box tag={Link} to={to} display="block" padding={3} hasRadius
    background={active ? 'primary100' : 'neutral0'} style={{ textDecoration: 'none' }}>
    <Flex justifyContent="space-between" alignItems="center" gap={2}>
      <Typography variant="omega" textColor={active ? 'primary700' : 'neutral800'}
        fontWeight={active ? 'bold' : 'regular'} style={{ textTransform: 'capitalize' }}>
        {label}
      </Typography>
      {count != null && <Badge textColor="neutral600" backgroundColor="neutral150">{count}</Badge>}
    </Flex>
  </Box>
);

const SiteCommerce = () => {
  const { slug, role = 'products' } = useParams();
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [params, setParams] = useSearchParams();

  const page = Math.max(1, Number(params.get('page') || 1));
  const pageSize = Number(params.get('pageSize') || 10);
  const q = params.get('q') ?? '';
  const tab = params.get('tab') ?? 'all';

  const [site, setSite] = useState<Site | null>(null);
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState(q);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: s }, { data: c }] = await Promise.all([
          get(`/site-dashboard/sites/${slug}`),
          get(`/site-dashboard/sites/${slug}/commerce`),
        ]);
        setSite(s.site ?? null);
        setCounts(c.counts ?? {});
      } catch {
        /* the table below reports its own failure; a missing rail is survivable */
      }
    })();
  }, [get, slug]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const search = new URLSearchParams({
        page: String(page), pageSize: String(pageSize),
        ...(q ? { q } : {}), ...(tab !== 'all' ? { tab } : {}),
      });
      const { data } = await get(`/site-dashboard/sites/${slug}/commerce/${role}?${search}`);
      setListing(data);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Could not load that list.');
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [get, slug, role, page, pageSize, q, tab]);

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
      await put(`/site-dashboard/sites/${slug}/commerce/${role}/publish`, {
        documentId: item.documentId, published: next,
      });
      toggleNotification({ type: 'success', message: next ? 'Enabled.' : 'Disabled — it is a draft again.' });
      await load();
    } catch (e: any) {
      toggleNotification({ type: 'danger', message: e?.response?.data?.error ?? e?.message ?? 'Could not change that.' });
    } finally {
      setBusy(null);
    }
  };

  const from = listing ? (listing.page - 1) * listing.pageSize + 1 : 0;
  const to = listing ? Math.min(listing.total, listing.page * listing.pageSize) : 0;

  return (
    <Main>
      <Box padding={8}>
        <Flex justifyContent="space-between" alignItems="flex-start" gap={4} paddingBottom={6}>
          <Box>
            <Flex gap={2} alignItems="center" paddingBottom={1}>
              <Button variant="tertiary" size="S" tag={Link} to="../..">← All sites</Button>
              <Typography variant="pi" textColor="neutral500">{site?.name ?? slug} · catalogue</Typography>
            </Flex>
            <Typography variant="alpha" style={{ textTransform: 'capitalize' }}>{role}</Typography>
            <Box paddingTop={1}>
              <Typography variant="epsilon" textColor="neutral600">
                {loading ? 'Counting…' : `${listing?.total ?? 0} on ${site?.name ?? slug}`}
              </Typography>
            </Box>
          </Box>
          <Flex gap={2}>
            {TOOLS.map((t) => (
              <Button key={t.id} variant="secondary" size="S" tag="a" href={`/admin/plugins/${t.id}`}>{t.label}</Button>
            ))}
          </Flex>
        </Flex>

        {error && (
          <Box paddingBottom={4}>
            <Alert variant="danger" title="Problem" onClose={() => setError('')}>{error}</Alert>
          </Box>
        )}

        <Flex alignItems="flex-start" gap={6}>
          <Box style={{ width: 220, flexShrink: 0 }}>
            <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150" padding={3}>
              <Flex direction="column" alignItems="stretch" gap={1}>
                {ROLES.map((r) => (
                  <RailLink key={r} to={`../commerce/${r}`} label={r} count={counts[r]} active={r === role} />
                ))}
              </Flex>
            </Box>
            <Box paddingTop={4}>
              <Box paddingLeft={3} paddingBottom={2}>
                <Typography variant="sigma" textColor="neutral600">Content</Typography>
              </Box>
              <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150" padding={3}>
                <RailLink to="../posts" label="posts" active={false} />
              </Box>
            </Box>
          </Box>

          <Box style={{ flex: 1, minWidth: 0 }}>
            <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150">
              <Box padding={4}>
                <Flex justifyContent="space-between" gap={3} alignItems="center">
                  {role === 'products' ? (
                    <Flex gap={2}>
                      {TABS.map((t) => (
                        <Button key={t.id} variant={tab === t.id ? 'secondary' : 'tertiary'} size="S"
                          onClick={() => setParam({ tab: t.id === 'all' ? null : t.id, page: '1' })}>
                          {t.label}
                        </Button>
                      ))}
                    </Flex>
                  ) : <Box />}
                  <Box style={{ maxWidth: 280, width: '100%' }}>
                    <Searchbar name="search" value={draft}
                      onChange={(e: any) => setDraft(e.target.value)}
                      onKeyDown={(e: any) => { if (e.key === 'Enter') setParam({ q: draft, page: '1' }); }}
                      onClear={() => { setDraft(''); setParam({ q: null, page: '1' }); }}
                      placeholder={`Search ${role}`}>
                      Search
                    </Searchbar>
                  </Box>
                </Flex>
              </Box>

              {loading ? (
                <Flex justifyContent="center" padding={10}><Loader>Loading</Loader></Flex>
              ) : !listing || listing.items.length === 0 ? (
                <Box padding={8}>
                  <EmptyStateLayout content={q ? `Nothing matching “${q}”.` : `No ${role} here.`} />
                </Box>
              ) : (
                <Table colCount={4} rowCount={listing.items.length}>
                  <Thead>
                    <Tr>
                      <Th><Typography variant="sigma">Name</Typography></Th>
                      <Th><Typography variant="sigma">Enabled</Typography></Th>
                      <Th><Typography variant="sigma">Updated</Typography></Th>
                      <Th><Typography variant="sigma">Actions</Typography></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {listing.items.map((item) => (
                      <Tr key={item.documentId}>
                        <Td><Typography textColor="neutral800" ellipsis>{item.name}</Typography></Td>
                        <Td>
                          {listing.canPublish ? (
                            <Switch checked={item.published} disabled={busy === item.documentId}
                              onCheckedChange={(next: boolean) => togglePublish(item, next)}
                              visibleLabels onLabel="On" offLabel="Off" />
                          ) : (
                            <Badge textColor="neutral600" backgroundColor="neutral150">{item.status ?? '—'}</Badge>
                          )}
                        </Td>
                        <Td><Typography variant="pi" textColor="neutral600">{fmtDate(item.updatedAt)}</Typography></Td>
                        <Td>
                          <Button variant="tertiary" size="S" tag="a"
                            href={`/admin/content-manager/collection-types/${item.uid}/${item.documentId}`}>
                            Edit
                          </Button>
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
                        <SingleSelect size="S" value={String(listing.pageSize)} aria-label="Per page"
                          onChange={(v: any) => setParam({ pageSize: String(v), page: '1' })}>
                          {['10', '20', '50', '100'].map((n) => (
                            <SingleSelectOption key={n} value={n}>{n} per page</SingleSelectOption>
                          ))}
                        </SingleSelect>
                      </Box>
                      <Flex gap={1} alignItems="center">
                        <Button variant="tertiary" size="S" disabled={listing.page <= 1}
                          onClick={() => setParam({ page: String(listing.page - 1) })}>Previous</Button>
                        <Box paddingLeft={2} paddingRight={2}>
                          <Typography variant="pi" textColor="neutral600">{listing.page} / {listing.pageCount}</Typography>
                        </Box>
                        <Button variant="tertiary" size="S" disabled={listing.page >= listing.pageCount}
                          onClick={() => setParam({ page: String(listing.page + 1) })}>Next</Button>
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

export { SiteCommerce };
export default SiteCommerce;
