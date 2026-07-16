'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Merchant, ProductSearchFilters, ProductSearchResult } from '@/lib/types';
import { STOREFRONTS } from '@/lib/storefronts';

type SearchResponse = {
  mode: string;
  message: string;
  results: ProductSearchResult[];
};

const RESULTS_PAGE_SIZE = 10;

export default function Page() {
  const [keyword, setKeyword] = useState('');
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [selectedMerchants, setSelectedMerchants] = useState<string[]>([]);
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [visibleCount, setVisibleCount] = useState(RESULTS_PAGE_SIZE);
  const [selected, setSelected] = useState<Record<string, ProductSearchResult>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [productType, setProductType] = useState<ProductSearchFilters['productType']>('all');
  const [excludeKeyword, setExcludeKeyword] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [excludeAccessories, setExcludeAccessories] = useState(true);
  const [sortBy, setSortBy] = useState<ProductSearchFilters['sortBy']>('relevance');
  const [perMerchantLimit, setPerMerchantLimit] = useState('10');
  const [storefront, setStorefront] = useState<string>(STOREFRONTS[0].key);
  const [importSpecs, setImportSpecs] = useState(true);
  const [importDescription, setImportDescription] = useState(false);
  const [overwriteProductDetails, setOverwriteProductDetails] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [categories, setCategories] = useState<{ name: string; slug: string }[]>([]);
  const [targetCategory, setTargetCategory] = useState('');
  const [combineIntoOne, setCombineIntoOne] = useState(false);

  useEffect(() => {
    fetch('/api/merchants')
      .then((response) => response.json())
      .then((data) => {
        const rows = data.merchants || [];
        setMerchants(rows);
        setSelectedMerchants(rows.slice(0, 5).map((merchant: Merchant) => merchant.slug));
      })
      .catch(() => setError('Could not load merchants.'));
  }, []);

  useEffect(() => {
    fetch('/api/categories')
      .then((response) => response.json())
      .then((data) => setCategories(Array.isArray(data.categories) ? data.categories : []))
      .catch(() => {});
  }, []);

  const selectedCount = Object.keys(selected).length;
  const sortedResults = useMemo(() => results, [results]);
  const visibleResults = sortedResults.slice(0, visibleCount);
  const hasMoreResults = visibleCount < sortedResults.length;

  useEffect(() => {
    if (!hasMoreResults) return;

    const target = loadMoreRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisibleCount((current) => Math.min(current + RESULTS_PAGE_SIZE, sortedResults.length));
      },
      { rootMargin: '420px 0px' },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMoreResults, sortedResults.length]);

  async function search() {
    setLoading(true);
    setError('');
    setNotice('');
    setSelected({});
    setVisibleCount(RESULTS_PAGE_SIZE);
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword,
          merchants: selectedMerchants,
          filters: {
            productType,
            excludeKeyword: excludeKeyword.trim() || undefined,
            minPrice: minPrice.trim() ? Number(minPrice) : undefined,
            excludeAccessories,
            perMerchantLimit: perMerchantLimit.trim() ? Number(perMerchantLimit) : 10,
            sortBy,
          },
        }),
      });
      const data = (await response.json()) as SearchResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Search failed.');
      setResults(data.results || []);
      setNotice(data.message || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  function toggleMerchant(slug: string) {
    setSelectedMerchants((current) =>
      current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug],
    );
  }

  function keyFor(item: ProductSearchResult) {
    return `${item.merchantSlug}:${item.sku || item.productUrl}`;
  }

  function identifiersFor(item: ProductSearchResult) {
    return [
      ['SKU', item.sku],
      ['Merchant SKU', item.merchantSku],
      ['ASIN', item.asin],
      ['GTIN', item.gtin],
      ['MPN', item.mpn],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  }

  function specCountFor(item: ProductSearchResult) {
    return Object.keys(item.specifications || {}).length + (item.featureBullets?.length ? 1 : 0);
  }

  function toggleResult(item: ProductSearchResult) {
    const key = keyFor(item);
    setSelected((current) => {
      const next = { ...current };
      if (next[key]) delete next[key];
      else next[key] = item;
      return next;
    });
  }

  async function addSelected(dryRun: boolean) {
    const items = Object.values(selected);
    if (!items.length) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const outcomes = [];
      // When combining, the first added item creates/updates the product and the
      // rest attach their offers to it (so different marketplaces share one
      // product). Combine only applies to live writes, not dry runs.
      let targetProductDocumentId: string | undefined;
      for (const item of items) {
        const response = await fetch('/api/add-to-strapi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item,
            dryRun,
            importSpecs,
            importDescription,
            overwriteProductDetails,
            storefront,
            categoryName: targetCategory.trim() || undefined,
            targetProductDocumentId: combineIntoOne ? targetProductDocumentId : undefined,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || data.error || 'Add to Strapi failed.');
        if (combineIntoOne && !dryRun && !targetProductDocumentId) {
          targetProductDocumentId = data.product?.documentId;
        }
        outcomes.push(data);
      }
      setNotice(
        combineIntoOne && !dryRun
          ? `Saved ${outcomes.length} offer(s) onto one product.`
          : `${dryRun ? 'Dry run checked' : 'Saved'} ${outcomes.length} product(s).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add to Strapi failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">NXT.Bargains</p>
          <h1>Commerce Sourcing</h1>
        </div>
        <div className="status">
          <span>{merchants.length} merchants</span>
          <span>{selectedCount} selected</span>
          <span>{visibleResults.length}/{sortedResults.length} shown</span>
        </div>
      </header>

      {(notice || error) && (
        <section className={`notice ${error ? 'danger' : ''}`}>
          {error || notice}
        </section>
      )}

      <div className="searchLayout">
        <aside className="filterSidebar">
          <div className="sidebarBlock filterBlock">
            <label className="selectOnly">
              <span>Sort</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value as ProductSearchFilters['sortBy'])}>
                <option value="relevance">Best match</option>
                <option value="price_asc">Cheapest first</option>
                <option value="price_desc">Most expensive first</option>
              </select>
            </label>
            <label>
              Exclude keyword
              <input
                value={excludeKeyword}
                onChange={(event) => setExcludeKeyword(event.target.value)}
                placeholder="renewed, case, charger"
              />
            </label>
            <label>
              Per merchant
              <input
                min="1"
                max="50"
                onChange={(event) => setPerMerchantLimit(event.target.value)}
                step="1"
                type="number"
                value={perMerchantLimit}
              />
            </label>
            <label className="checkToggle">
              <input
                checked={excludeAccessories}
                disabled={productType === 'accessories'}
                onChange={(event) => setExcludeAccessories(event.target.checked)}
                type="checkbox"
              />
              <span>Exclude accessories</span>
            </label>
          </div>

          <div className="sidebarBlock searchBlock">
            <p className="panelTitle">Search</p>
            <label>
              Keyword
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') search();
                }}
                placeholder="Google Pixel 8, iPhone 16, PS5"
              />
            </label>
            <button
              className="primary searchButton"
              disabled={loading || keyword.trim().length < 2 || !selectedMerchants.length}
              onClick={search}
            >
              {loading ? 'Searching...' : 'Search merchants'}
            </button>
          </div>

          <div className="sidebarBlock">
            <p className="panelTitle">Import details</p>
            <label className="checkToggle">
              <input
                checked={importSpecs}
                onChange={(event) => setImportSpecs(event.target.checked)}
                type="checkbox"
              />
              <span>Import product specifications</span>
            </label>
            <label className="checkToggle">
              <input
                checked={importDescription}
                onChange={(event) => setImportDescription(event.target.checked)}
                type="checkbox"
              />
              <span>Import merchant description</span>
            </label>
            <label className="checkToggle">
              <input
                checked={overwriteProductDetails}
                onChange={(event) => setOverwriteProductDetails(event.target.checked)}
                type="checkbox"
              />
              <span>Overwrite existing details</span>
            </label>
            <p className="sidebarHint">
              Specs are saved to Strapi when merchants provide them. Descriptions stay manual unless enabled.
            </p>
          </div>

          <div className="sidebarBlock">
            <div className="panelTitleRow">
              <p className="panelTitle">Merchants</p>
              <button className="smallButton" onClick={() => setSelectedMerchants(merchants.map((merchant) => merchant.slug))}>
                All
              </button>
            </div>
            <div className="merchantList">
              {merchants.map((merchant) => (
                <label key={merchant.slug} className="merchantToggle">
                  <input
                    type="checkbox"
                    checked={selectedMerchants.includes(merchant.slug)}
                    onChange={() => toggleMerchant(merchant.slug)}
                  />
                  <span>{merchant.name}</span>
                </label>
              ))}
            </div>
          </div>
        </aside>

        <section className="resultsPanel">
          <div className="resultsToolbar">
            <div>
              <p className="eyebrow">Results</p>
              <h2>{sortedResults.length ? `${sortedResults.length} products found` : 'Search results'}</h2>
            </div>
            <div className="actions">
              <input
                list="commerce-category-options"
                className="categoryPicker"
                placeholder="Category (detected per product)"
                aria-label="Target category for selected products"
                value={targetCategory}
                onChange={(event) => setTargetCategory(event.target.value)}
              />
              <datalist id="commerce-category-options">
                {categories.map((category) => (
                  <option key={category.slug || category.name} value={category.name} />
                ))}
              </datalist>
              <label className="combineToggle" title="Attach all selected listings as offers on a single product (use for the same product across different marketplaces).">
                <input
                  type="checkbox"
                  checked={combineIntoOne}
                  onChange={(event) => setCombineIntoOne(event.target.checked)}
                />
                Combine into one product
              </label>
              <label className="storefrontPicker" title="Which storefront these products are imported to. Each site only shows products tagged for it.">
                <span>Import to</span>
                <select value={storefront} onChange={(event) => setStorefront(event.target.value)}>
                  {STOREFRONTS.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button disabled={!selectedCount || saving} onClick={() => addSelected(true)}>
                Dry run
              </button>
              <button className="primary" disabled={!selectedCount || saving} onClick={() => addSelected(false)}>
                {saving ? 'Saving...' : `Add selected${selectedCount ? ` (${selectedCount})` : ''}`}
              </button>
            </div>
          </div>

          <div className="resultsList">
            {visibleResults.length === 0 ? (
              <div className="empty">
                {loading ? 'Searching merchant catalogs...' : 'Search a keyword to compare merchant results.'}
              </div>
            ) : (
              visibleResults.map((item) => {
                const key = keyFor(item);
                const identifiers = identifiersFor(item);
                return (
                  <article className="resultCard" key={key}>
                    <label className="selectBox">
                      <input
                        aria-label={`Select ${item.productName}`}
                        type="checkbox"
                        checked={Boolean(selected[key])}
                        onChange={() => toggleResult(item)}
                      />
                    </label>

                    <div className="productImage">
                      <img src={item.imageUrl || '/placeholder.png'} alt="" />
                    </div>

                    <div className="resultMain">
                      <div className="resultTitleRow">
                        <div>
                          <h3>{item.productName}</h3>
                          <p>{[item.brand, item.category].filter(Boolean).join(' / ') || 'Uncategorized'}</p>
                        </div>
                        <div className="price">
                          {item.price ? `${item.currency} ${item.price.toFixed(2)}` : 'Check price'}
                          {item.originalPrice && <small>{item.currency} {item.originalPrice.toFixed(2)}</small>}
                        </div>
                      </div>

                      <div className="resultMeta">
                        <span>{item.merchantName}</span>
                        <span>{item.availability.replace(/_/g, ' ')}</span>
                        <span>{item.source}</span>
                        <span>{item.confidence}</span>
                        {specCountFor(item) > 0 && <span>{specCountFor(item)} spec fields</span>}
                      </div>

                      <div className="resultFooter">
                        <div className="identifiers">
                          {identifiers.length ? (
                            identifiers.slice(0, 3).map(([label, value]) => (
                              <span key={label}>
                                <strong>{label}</strong>
                                <code>{value}</code>
                              </span>
                            ))
                          ) : (
                            <span className="muted">No SKU</span>
                          )}
                        </div>
                        <a className="merchantLink" href={item.productUrl} target="_blank" rel="noreferrer">
                          Open merchant page
                        </a>
                      </div>
                    </div>
                  </article>
                );
              })
            )}

            {hasMoreResults && (
              <div className="loadMore" ref={loadMoreRef}>
                Loading more results...
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
