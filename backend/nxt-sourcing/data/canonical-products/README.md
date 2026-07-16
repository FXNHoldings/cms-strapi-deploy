# Canonical Product Reference

This directory stores the product reference table used for bulk sourcing and duplicate-safe imports.

The goal is to describe the real product before searching marketplaces. Search providers can then use
the reference data to find offers, score matches, and avoid importing accessories, bundles, carrier
variants, or duplicate listings as separate products.

## Matching Priority

1. `gtin`, `upc`, `ean`, or `isbn`
2. `mpn` / manufacturer model number
3. store-specific IDs such as `asin`, `tcin`, `bestBuySku`, `walmartItemId`
4. exact canonical title plus required variant terms
5. aliases and search queries

## Identifier Notes

Do not guess identifiers. Leave fields blank and set `identifierStatus` to `needs_verification` until
the value has been confirmed from a reliable source such as the manufacturer, a trusted product feed,
packaging barcode data, or a marketplace product detail page.

## Suggested Flow

1. Add product families and variants here.
2. Run a sourcing script against Real-Time Product Search.
3. Score results using `requiredTerms`, `excludeTerms`, and identifiers.
4. Import only high-confidence results into Strapi.
5. Store marketplace offers and price snapshots separately from the canonical product.
