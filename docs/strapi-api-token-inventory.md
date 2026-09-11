# Strapi API token inventory

Recorded 11 Sep 2026, before deleting the tokens invalidated by the
API_TOKEN_SALT change. These names are the only map of which integrations
hold a token on this CMS -- deleting the rows without keeping this loses
the list of what has to be re-issued.

Every token below stopped validating when the strapi-cms container was
recreated on 10 Sep 23:43 with an API_TOKEN_SALT that matches no file on
disk. Strapi hashes tokens with that salt, so all 24 failed at once.
Deleting them restores nothing; each consumer still needs a new token.

| id | name | type | created |
| --- | --- | --- | --- |
| 1 | Read Only | read-only | 2026-04-20 |
| 2 | Full Access | full-access | 2026-04-20 |
| 3 | autopost-worker | full-access | 2026-04-20 |
| 5 | ai-writer | full-access | 2026-04-22 |
| 6 | nxt-bargains-importer | full-access | 2026-05-02 |
| 7 | bestlooking-skin-import | full-access | 2026-05-02 |
| 8 | apify-product-import | full-access | 2026-05-02 |
| 9 | eBay Sync | full-access | 2026-05-02 |
| 10 | Projects | full-access | 2026-05-12 |
| 11 | search-multi-merchent | full-access | 2026-05-12 |
| 12 | article feature images | full-access | 2026-05-30 |
| 13 | Bravo Email | full-access | 2026-05-30 |
| 15 | airport-ingest | full-access | 2026-06-12 |
| 16 | strapi-ingest-token | full-access | 2026-06-12 |
| 17 | elegantstack | full-access | 2026-07-10 |
| 18 | nxt.bargains | full-access | 2026-07-15 |
| 19 | content-recovery | full-access | 2026-07-29 |
| 20 | nxtsmarthomes | full-access | 2026-07-30 |
| 21 | clawbase | full-access | 2026-07-31 |
| 22 | fxnseo | full-access | 2026-08-04 |
| 23 | nxtsmarthome.com.au | full-access | 2026-08-12 |
| 25 | airline | custom | 2026-08-23 |
| 26 | zenrows | full-access | 2026-08-25 |
| 27 | nxt.deals | full-access | 2026-09-10 |

Kept: id 28 `ovhloud` (created 11 Sep 04:43, after the salt change) --
the only working token, currently used by nxt-sourcing.
