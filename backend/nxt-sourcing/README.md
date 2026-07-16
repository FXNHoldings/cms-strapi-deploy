# NXT Commerce Sourcing

Internal sourcing app for searching merchant products and adding selected results to Strapi Commerce.

Current status:

- Demo provider is available only when `SHOW_DEMO_RESULTS=true`.
- Live eBay provider. Browse API is used when `EBAY_OAUTH_TOKEN` or full eBay app credentials are configured; eBay Finding API is used when only `EBAY_APP_ID` / `EBAY_CLIENT_ID` is configured.
- Live Impact Product Catalog search provider when `IMPACT_ACCOUNT_SID` and `IMPACT_AUTH_TOKEN` are configured. Walmart searches use this provider directly when Walmart is selected.
- Real-Time Product Search via RapidAPI/OpenWeb Ninja when `RAPIDAPI_PRODUCT_SEARCH_KEY` or `RAPIDAPI_KEY` is configured. This searches Google Shopping aggregate offers across many merchants.
- Geniuslink API support for creating server-side affiliate short URLs during Strapi imports.
- Dry-run add flow.
- Live writes require `STRAPI_API_TOKEN`.
- Demo results are blocked from live writes.

Run locally:

```sh
npm install
npm run build
npm run start
```

Open:

```text
http://127.0.0.1:3005
```

Environment:

```sh
cp .env.example .env.local
```

For eBay, use either a ready-made `EBAY_OAUTH_TOKEN`, set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`, or set only `EBAY_APP_ID` / `EBAY_CLIENT_ID`. In eBay's dashboard, App ID is the Client ID and Cert ID is the Client Secret. When OAuth credentials are present, the app uses Browse API. When only App ID is present, it uses the App-ID-only Finding API.

For Impact, set `IMPACT_ACCOUNT_SID` and `IMPACT_AUTH_TOKEN`. The app adds an `Impact Catalog` search source and calls `/Mediapartners/<AccountSID>/Catalogs/ItemSearch` with the keyword you enter. Walmart searches also use Impact directly. Optional Walmart-specific settings are `IMPACT_WALMART_PRODUCT_SEARCH_URL`, `IMPACT_WALMART_CAMPAIGN_ID`, `IMPACT_WALMART_CATALOG_ID`, `IMPACT_WALMART_QUERY`, `IMPACT_WALMART_LIMIT`, and `IMPACT_WALMART_TIMEOUT_MS`.

For Amazon search, set `RAPIDAPI_PRODUCT_SEARCH_KEY` or a shared `RAPIDAPI_KEY`. Amazon search uses the Letscrape Real-Time Product Search API. Selected Amazon imports can still use Real-Time Amazon Data (`RAPIDAPI_AMAZON_KEY` / `RAPIDAPI_AMAZON_HOST`) for product detail enrichment from `RAPIDAPI_AMAZON_DETAILS_PATH`.

For Real-Time Product Search, set `RAPIDAPI_PRODUCT_SEARCH_KEY` or a shared `RAPIDAPI_KEY`. The app calls `https://real-time-product-search.p.rapidapi.com/search-v2` with `q`, `country`, `language`, `page`, `limit`, and `sort_by`, then maps each offer to its actual merchant name such as Amazon, Target, Newegg, Walmart, or Best Buy when the API provides it.

Price history can be imported with:

```sh
node scripts/fetch-product-price-history.mjs --dry-run
node scripts/fetch-product-price-history.mjs --write
```

The job searches active Strapi Commerce products through Real-Time Product Search, matches merchant offers, recreates/updates `commerce-offers` when needed, and writes dated rows to `commerce-price-snapshots`. It imports any `price_history` arrays returned by the API and also records the current price as today's snapshot. Tune it with `PRICE_HISTORY_REFRESH_LIMIT`, `PRICE_HISTORY_MERCHANT_SLUGS`, and `PRICE_HISTORY_MAX_SNAPSHOTS_PER_PRODUCT`.

For Geniuslink, set `GENIUSLINK_API_KEY` and `GENIUSLINK_API_SECRET`. Optional settings include `GENIUSLINK_DOMAIN=buy.geni.us`, `GENIUSLINK_GROUP_ID`, and `GENIUSLINK_MERCHANT_SLUGS`. When enabled, selected merchant imports can create a Geniuslink short URL and store it as the Strapi offer `affiliateUrl`.

Keep this app bound to `127.0.0.1` until basic auth or a protected reverse proxy is added.
