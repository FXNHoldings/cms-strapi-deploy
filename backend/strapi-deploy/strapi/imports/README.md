# Commerce CSV Imports

Use `commerce-products-template.csv` as the starting format for shared Commerce products and merchant offers.

Dry-run first:

```sh
docker cp ./imports/my-products.csv fxn-strapi:/opt/app/imports/my-products.csv
docker exec fxn-strapi npm run commerce:import -- --file /opt/app/imports/my-products.csv --dry-run
```

Run the import:

```sh
docker exec fxn-strapi npm run commerce:import -- --file /opt/app/imports/my-products.csv
```

Required columns:

```text
merchantSlug,productName,productUrl,price
```

The importer matches existing products by `gtin`, `asin`, `mpn`, `sku`, then product `slug`. It creates missing merchants, brands, categories, products, offers, and price snapshots. Existing product records are not overwritten; matching offers are updated with the latest price/link data.
