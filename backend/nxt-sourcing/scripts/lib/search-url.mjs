/**
 * Is this URL a retailer's search page rather than a product page?
 *
 * Shared deliberately: the link checker uses it to decide what it cannot judge,
 * and the cleaner uses it to decide what to remove. If the two ever disagreed,
 * the checker would sit judging pages the cleaner meant to delete.
 *
 * The patterns are broader than they look because retailers are inventive.
 * Target alone defeated the first version twice over: its URLs are
 * `/s?searchTerm=...` — the path is not "search", and the parameter is not "q".
 * Amazon uses `/s?k=`, Kogan `/au/s/?q=`, Harvey Norman `/catalogsearch/result/`.
 */
const SEARCH_PATHS = /(^|\/)(s|search|catalogsearch|find|results|browse|sq)(\/|$)/i;

const SEARCH_PARAMS = new Set([
  'q', 'query', 's', 'k', 'keyword', 'keywords',
  'searchterm', 'search_term', 'search', 'term', 'text', 'st', 'w',
]);

export function isSearchUrl(url) {
  try {
    const u = new URL(url);
    if (SEARCH_PATHS.test(u.pathname)) return true;
    for (const key of u.searchParams.keys()) {
      if (SEARCH_PARAMS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}
