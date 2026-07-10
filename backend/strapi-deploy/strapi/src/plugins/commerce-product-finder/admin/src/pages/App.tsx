import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Field,
  Flex,
  Grid,
  Main,
  SingleSelect,
  SingleSelectOption,
  TextInput,
  Textarea,
  Typography,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

type Merchant = {
  documentId: string;
  name: string;
  slug: string;
  websiteUrl?: string;
};

type ProductResult = {
  documentId: string;
  name: string;
  slug: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
  asin?: string;
  gtin?: string;
  mpn?: string;
  sku?: string;
  bestOffer?: {
    merchantName?: string;
    merchantSlug?: string;
    price?: string | number;
    currency?: string;
    productUrl?: string;
    affiliateUrl?: string;
    availability?: string;
  } | null;
};

const emptyForm = {
  productDocumentId: '',
  productName: '',
  productSlug: '',
  brand: '',
  category: '',
  merchantSlug: '',
  merchantName: '',
  merchantWebsite: '',
  productUrl: '',
  affiliateUrl: '',
  imageUrl: '',
  price: '',
  originalPrice: '',
  currency: 'USD',
  availability: 'unknown',
  condition: 'new',
  asin: '',
  gtin: '',
  mpn: '',
  sku: '',
  merchantSku: '',
  shortDescription: '',
  description: '',
};

export const App = () => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [q, setQ] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [searchMerchant, setSearchMerchant] = useState('');
  const [results, setResults] = useState<ProductResult[]>([]);
  const [form, setForm] = useState<any>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<any>(null);

  useEffect(() => {
    get('/commerce-product-finder/merchants')
      .then(({ data }: any) => setMerchants(data || []))
      .catch(() => setMerchants([]));
  }, [get]);

  const update = (key: string, value: string) => {
    setForm((current: any) => ({ ...current, [key]: value }));
  };

  const selectedMerchant = merchants.find((merchant) => merchant.slug === form.merchantSlug);

  const chooseMerchant = (slug: string) => {
    if (slug === 'new') {
      setForm((current: any) => ({ ...current, merchantSlug: '' }));
      return;
    }
    const merchant = merchants.find((item) => item.slug === slug);
    setForm((current: any) => ({
      ...current,
      merchantSlug: slug,
      merchantName: merchant?.name || current.merchantName,
      merchantWebsite: merchant?.websiteUrl || current.merchantWebsite,
    }));
  };

  const runSearch = async () => {
    if (q.trim().length < 2) return;
    setLoading(true);
    setError(null);
    setSaved(null);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (searchMerchant) params.set('merchantSlug', searchMerchant);
      const { data } = await get(`/commerce-product-finder/search?${params.toString()}`);
      setResults(data?.results || []);
    } catch (e: any) {
      setError(e?.response?.data?.error?.message || e.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const preview = async () => {
    if (!previewUrl.trim()) return;
    setLoading(true);
    setError(null);
    setSaved(null);
    try {
      const { data } = await post('/commerce-product-finder/preview-url', { url: previewUrl.trim() });
      setForm((current: any) => ({ ...current, ...data }));
      toggleNotification({ type: 'success', message: 'Product details loaded from URL.' });
    } catch (e: any) {
      setError(e?.response?.data?.error?.message || e.message || 'URL preview failed');
    } finally {
      setLoading(false);
    }
  };

  const useProduct = (product: ProductResult) => {
    setForm((current: any) => ({
      ...current,
      productDocumentId: product.documentId,
      productName: product.name || '',
      productSlug: product.slug || '',
      brand: product.brand || '',
      category: product.category || '',
      imageUrl: product.imageUrl || '',
      asin: product.asin || '',
      gtin: product.gtin || '',
      mpn: product.mpn || '',
      sku: product.sku || '',
      merchantSlug: product.bestOffer?.merchantSlug || current.merchantSlug,
      merchantName: product.bestOffer?.merchantName || current.merchantName,
      productUrl: product.bestOffer?.productUrl || current.productUrl,
      affiliateUrl: product.bestOffer?.affiliateUrl || current.affiliateUrl,
      price: product.bestOffer?.price ? String(product.bestOffer.price) : current.price,
      currency: product.bestOffer?.currency || current.currency,
      availability: product.bestOffer?.availability || current.availability,
    }));
    toggleNotification({ type: 'info', message: 'Existing product selected. Add or update the merchant offer below.' });
  };

  const save = async () => {
    setLoading(true);
    setError(null);
    setSaved(null);
    try {
      const payload = {
        ...form,
        merchantName: form.merchantName || selectedMerchant?.name,
        merchantWebsite: form.merchantWebsite || selectedMerchant?.websiteUrl,
      };
      const { data } = await post('/commerce-product-finder/save', payload);
      setSaved(data);
      toggleNotification({ type: 'success', message: 'Commerce product saved.' });
    } catch (e: any) {
      setError(e?.response?.data?.error?.message || e.message || 'Save failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Main>
      <Box padding={8}>
        <Typography variant="alpha">Commerce Products</Typography>
        <Box paddingTop={2} paddingBottom={6}>
          <Typography variant="omega" textColor="neutral600">
            Find existing shared products, preview a merchant URL, then save the product and offer into Commerce.
          </Typography>
        </Box>

        <Grid.Root gap={4}>
          <Grid.Item col={6} s={12}>
            <Box padding={5} background="neutral100" hasRadius>
              <Typography variant="delta">Search existing products</Typography>
              <Box paddingTop={4}>
                <Field.Root name="search">
                  <Field.Label>Keyword, ASIN, SKU, brand, or category</Field.Label>
                  <TextInput value={q} onChange={(e: any) => setQ(e.target.value)} />
                </Field.Root>
              </Box>
              <Box paddingTop={4}>
                <Field.Root name="searchMerchant">
                  <Field.Label>Merchant filter</Field.Label>
                  <SingleSelect value={searchMerchant || 'all'} onChange={(value: any) => setSearchMerchant(value === 'all' ? '' : value)}>
                    <SingleSelectOption value="all">All merchants</SingleSelectOption>
                    {merchants.map((merchant) => (
                      <SingleSelectOption key={merchant.slug} value={merchant.slug}>
                        {merchant.name}
                      </SingleSelectOption>
                    ))}
                  </SingleSelect>
                </Field.Root>
              </Box>
              <Box paddingTop={4}>
                <Button loading={loading} disabled={q.trim().length < 2} onClick={runSearch}>
                  Search
                </Button>
              </Box>
            </Box>
          </Grid.Item>

          <Grid.Item col={6} s={12}>
            <Box padding={5} background="neutral100" hasRadius>
              <Typography variant="delta">Preview from product URL</Typography>
              <Box paddingTop={4}>
                <Field.Root name="previewUrl">
                  <Field.Label>Product URL</Field.Label>
                  <TextInput
                    value={previewUrl}
                    onChange={(e: any) => setPreviewUrl(e.target.value)}
                    placeholder="https://merchant.com/product-page"
                  />
                </Field.Root>
              </Box>
              <Box paddingTop={4}>
                <Button loading={loading} disabled={!previewUrl.trim()} onClick={preview}>
                  Preview URL
                </Button>
              </Box>
            </Box>
          </Grid.Item>
        </Grid.Root>

        {results.length > 0 && (
          <Box paddingTop={6}>
            <Typography variant="beta">Search results</Typography>
            <Grid.Root gap={4}>
              {results.map((product) => (
                <Grid.Item key={product.documentId} col={4} s={12}>
                  <Box padding={4} background="neutral100" hasRadius>
                    <Flex gap={3} alignItems="flex-start">
                      {product.imageUrl && (
                        <img
                          src={product.imageUrl}
                          alt=""
                          style={{ width: 72, height: 72, objectFit: 'contain', background: '#fff', borderRadius: 4 }}
                        />
                      )}
                      <Box>
                        <Typography fontWeight="bold">{product.name}</Typography>
                        <Typography textColor="neutral600">
                          {[product.brand, product.category].filter(Boolean).join(' · ')}
                        </Typography>
                        {product.bestOffer && (
                          <Typography textColor="neutral600">
                            {product.bestOffer.merchantName} · {product.bestOffer.currency || 'USD'} {product.bestOffer.price || ''}
                          </Typography>
                        )}
                      </Box>
                    </Flex>
                    <Box paddingTop={4}>
                      <Button variant="secondary" onClick={() => useProduct(product)}>
                        Use product
                      </Button>
                    </Box>
                  </Box>
                </Grid.Item>
              ))}
            </Grid.Root>
          </Box>
        )}

        <Box paddingTop={8}>
          <Typography variant="beta">Save product and offer</Typography>
          <Box paddingTop={4} background="neutral100" padding={5} hasRadius>
            <Grid.Root gap={4}>
              <Grid.Item col={8} s={12}>
                <Field.Root name="productName" required>
                  <Field.Label>Product name</Field.Label>
                  <TextInput value={form.productName} onChange={(e: any) => update('productName', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="productSlug">
                  <Field.Label>Product slug</Field.Label>
                  <TextInput value={form.productSlug} onChange={(e: any) => update('productSlug', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="brand">
                  <Field.Label>Brand</Field.Label>
                  <TextInput value={form.brand} onChange={(e: any) => update('brand', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="category">
                  <Field.Label>Category</Field.Label>
                  <TextInput value={form.category} onChange={(e: any) => update('category', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="merchant">
                  <Field.Label>Merchant</Field.Label>
                  <SingleSelect value={form.merchantSlug || 'new'} onChange={(value: any) => chooseMerchant(value || 'new')}>
                    <SingleSelectOption value="new">New merchant or none selected</SingleSelectOption>
                    {merchants.map((merchant) => (
                      <SingleSelectOption key={merchant.slug} value={merchant.slug}>
                        {merchant.name}
                      </SingleSelectOption>
                    ))}
                  </SingleSelect>
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="merchantName">
                  <Field.Label>Merchant name</Field.Label>
                  <TextInput value={form.merchantName} onChange={(e: any) => update('merchantName', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="merchantWebsite">
                  <Field.Label>Merchant website</Field.Label>
                  <TextInput value={form.merchantWebsite} onChange={(e: any) => update('merchantWebsite', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="price">
                  <Field.Label>Price</Field.Label>
                  <TextInput value={form.price} onChange={(e: any) => update('price', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="originalPrice">
                  <Field.Label>Original price</Field.Label>
                  <TextInput value={form.originalPrice} onChange={(e: any) => update('originalPrice', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="currency">
                  <Field.Label>Currency</Field.Label>
                  <TextInput value={form.currency} onChange={(e: any) => update('currency', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="availability">
                  <Field.Label>Availability</Field.Label>
                  <SingleSelect value={form.availability} onChange={(value: any) => update('availability', value || 'unknown')}>
                    <SingleSelectOption value="unknown">Unknown</SingleSelectOption>
                    <SingleSelectOption value="in_stock">In stock</SingleSelectOption>
                    <SingleSelectOption value="out_of_stock">Out of stock</SingleSelectOption>
                    <SingleSelectOption value="preorder">Preorder</SingleSelectOption>
                  </SingleSelect>
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={4} s={12}>
                <Field.Root name="condition">
                  <Field.Label>Condition</Field.Label>
                  <SingleSelect value={form.condition} onChange={(value: any) => update('condition', value || 'unknown')}>
                    <SingleSelectOption value="new">New</SingleSelectOption>
                    <SingleSelectOption value="used">Used</SingleSelectOption>
                    <SingleSelectOption value="refurbished">Refurbished</SingleSelectOption>
                    <SingleSelectOption value="open_box">Open box</SingleSelectOption>
                    <SingleSelectOption value="unknown">Unknown</SingleSelectOption>
                  </SingleSelect>
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={12} s={12}>
                <Field.Root name="productUrl" required>
                  <Field.Label>Product URL</Field.Label>
                  <TextInput value={form.productUrl} onChange={(e: any) => update('productUrl', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={12} s={12}>
                <Field.Root name="affiliateUrl">
                  <Field.Label>Affiliate URL</Field.Label>
                  <TextInput value={form.affiliateUrl} onChange={(e: any) => update('affiliateUrl', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={12} s={12}>
                <Field.Root name="imageUrl">
                  <Field.Label>Image URL</Field.Label>
                  <TextInput value={form.imageUrl} onChange={(e: any) => update('imageUrl', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={3} s={12}>
                <Field.Root name="asin">
                  <Field.Label>ASIN</Field.Label>
                  <TextInput value={form.asin} onChange={(e: any) => update('asin', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={3} s={12}>
                <Field.Root name="gtin">
                  <Field.Label>GTIN</Field.Label>
                  <TextInput value={form.gtin} onChange={(e: any) => update('gtin', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={3} s={12}>
                <Field.Root name="mpn">
                  <Field.Label>MPN</Field.Label>
                  <TextInput value={form.mpn} onChange={(e: any) => update('mpn', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={3} s={12}>
                <Field.Root name="sku">
                  <Field.Label>SKU</Field.Label>
                  <TextInput value={form.sku} onChange={(e: any) => update('sku', e.target.value)} />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={12} s={12}>
                <Field.Root name="shortDescription">
                  <Field.Label>Short description</Field.Label>
                  <Textarea value={form.shortDescription} onChange={(e: any) => update('shortDescription', e.target.value)} />
                </Field.Root>
              </Grid.Item>
            </Grid.Root>

            <Box paddingTop={5}>
              <Flex gap={3}>
                <Button
                  loading={loading}
                  disabled={!form.productName || (!form.productUrl && !form.affiliateUrl)}
                  onClick={save}
                >
                  Save to Commerce
                </Button>
                <Button variant="tertiary" onClick={() => { setForm(emptyForm); setSaved(null); }}>
                  Reset
                </Button>
              </Flex>
            </Box>
          </Box>
        </Box>

        {error && (
          <Box paddingTop={6}>
            <Alert variant="danger" title="Product finder failed">{error}</Alert>
          </Box>
        )}

        {saved && (
          <Box paddingTop={6}>
            <Alert variant="success" title="Saved">
              <Typography>
                {saved.product?.name} saved with {saved.merchant?.name}. Price snapshot:
                {' '}{saved.snapshotCreated ? 'created' : 'not created'}.
              </Typography>
            </Alert>
          </Box>
        )}
      </Box>
    </Main>
  );
};

export default App;
