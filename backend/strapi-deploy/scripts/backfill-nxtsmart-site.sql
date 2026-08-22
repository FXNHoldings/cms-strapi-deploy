-- Backfill the `site` field on the shared nxtsmart-* content types.
--
-- These types serve two properties. Until now nothing recorded which row
-- belonged to which, so the Content Manager showed one undifferentiated list.
--
-- The classification is evidence-based, not assumed:
--   * 48 posts have a sourceUrl on nxtsmarthome.com.au          -> nxtsmarthome.com.au
--   * 126 wp-import posts have a sourceUrl on nxtsmart.homes     -> nxtsmart.homes
--   * 14 'ai' posts have no sourceUrl, but link only to
--     WordPress-era categories (legacyWpId 485/486/487) and none
--     of their slugs exist as nxtsmarthome.com.au markdown       -> nxtsmart.homes
--   * 9 categories have no legacyWpId and hold all 48 manual posts -> nxtsmarthome.com.au
--   * 13 categories carry a legacyWpId                            -> nxtsmart.homes

BEGIN;

-- Decided per document, not per row. A document has a draft row and a published
-- row and only one may carry the sourceUrl; deciding per row would leave the
-- draft version of a nxtsmarthome article marked as the other site.
UPDATE nxtsmart_posts p
SET site = sub.site
FROM (
  SELECT document_id,
         CASE WHEN bool_or(source_url LIKE '%nxtsmarthome.com.au%')
              THEN 'nxtsmarthome.com.au'
              ELSE 'nxtsmart.homes'
         END AS site
  FROM nxtsmart_posts
  GROUP BY document_id
) sub
WHERE p.document_id = sub.document_id;

UPDATE nxtsmart_categories
SET site = CASE WHEN legacy_wp_id IS NULL
                THEN 'nxtsmarthome.com.au'
                ELSE 'nxtsmart.homes'
           END;

COMMIT;
