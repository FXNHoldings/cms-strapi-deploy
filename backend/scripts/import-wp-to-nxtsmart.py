#!/usr/bin/env python3
"""
Idempotent WP -> Strapi importer for NXTSmart.Homes.

Source:   https://nxtsmart.homes/wp-json/wp/v2  (REST API)
Target:   https://cms.fxnstudio.com/api  (Strapi, content types nxtsmart-post / nxtsmart-category)

Idempotency key:   legacyWpId (the WordPress post / category id)
Cover image:       extracted from JSON-LD `primaryImageOfPage["@id"]` on the post page HTML.
                   Stored as `coverImageUrl` (string). Strapi media upload not used.

Usage:
    STRAPI_API_TOKEN=... python3 import-wp-to-nxtsmart.py [--limit N] [--posts-only] [--categories-only] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WP_BASE = "https://nxtsmart.homes/wp-json/wp/v2"
STRAPI_BASE = "https://cms.fxnstudio.com/api"
UA = "Mozilla/5.0 (compatible; fxnstudio-importer/1.0)"

# WP category slug -> Strapi nxtsmart-post.postType enum
POST_TYPE_BY_CATEGORY_SLUG = {
    "how-to-guides": "how-to-guide",
    "product-reviews": "product-review",
    "informative-articles": "informative",
    "top-rated": "top-rated",
    "product-comparisons": "product-comparison",
    "product-roundups": "product-roundup",
    "smart-home-automation": "smart-home-automation",
    "smart-home-security": "smart-home-security",
    "smart-home-devices": "smart-home-devices",
    "smart-home-entertainment": "smart-home-entertainment",
    "smart-home-energy": "smart-home-energy",
    "smart-home-integration": "smart-home-integration",
    "coupons-and-deals": "other",
    "uncategorized": "other",
}

STRAPI_TOKEN = os.environ.get("STRAPI_API_TOKEN")
if not STRAPI_TOKEN:
    sys.exit("STRAPI_API_TOKEN env var is required")


def http(method: str, url: str, data=None, headers=None, max_retries: int = 3, timeout: int = 60):
    hdrs = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    body = json.dumps(data).encode() if data is not None else None
    if body:
        hdrs.setdefault("Content-Type", "application/json")
    last_err = None
    for attempt in range(max_retries):
        req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            if e.code in (429, 502, 503, 504) and attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
            return e.code, err_body
        except urllib.error.URLError as e:
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
            return 0, f"URLError: {e}"
    return 0, str(last_err)


def http_html(url: str) -> str:
    code, body = http("GET", url, headers={"Accept": "text/html"})
    return body if code == 200 else ""


def strapi(method: str, path: str, data=None):
    code, body = http(
        method,
        f"{STRAPI_BASE}{path}",
        data=data,
        headers={"Authorization": f"Bearer {STRAPI_TOKEN}"},
    )
    try:
        return code, json.loads(body)
    except (ValueError, json.JSONDecodeError):
        return code, body


def wp_paginated(endpoint: str, per_page: int = 100, extra=None):
    items, page = [], 1
    while True:
        qs = {"per_page": per_page, "page": page}
        if extra:
            qs.update(extra)
        url = f"{WP_BASE}/{endpoint}?{urllib.parse.urlencode(qs)}"
        code, body = http("GET", url)
        if code != 200:
            print(f"  WP {endpoint} page {page} -> {code}", file=sys.stderr)
            break
        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            break
        if not data:
            break
        items.extend(data)
        if len(data) < per_page:
            break
        page += 1
    return items


# ---------- Strapi lookups ----------

def find_category(legacy_wp_id: int):
    code, res = strapi(
        "GET",
        f"/nxtsmart-categories?filters[legacyWpId][$eq]={legacy_wp_id}&pagination[pageSize]=1",
    )
    return res["data"][0] if code == 200 and res.get("data") else None


def find_post(legacy_wp_id: int):
    code, res = strapi(
        "GET",
        f"/nxtsmart-posts?filters[legacyWpId][$eq]={legacy_wp_id}&pagination[pageSize]=1&publicationState=preview",
    )
    return res["data"][0] if code == 200 and res.get("data") else None


# ---------- Featured image extraction ----------

_LD_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)
_PRIM_IMG_KEY = re.compile(r'"primaryImageOfPage"\s*:\s*\{\s*"@id"\s*:\s*"([^"]+)"')


def extract_cover_image(post_url: str) -> tuple[str | None, str | None]:
    """Return (image_url, alt). Uses JSON-LD primaryImageOfPage; falls back to first non-Amazon content image."""
    html = http_html(post_url)
    if not html:
        return None, None

    # JSON-LD primaryImageOfPage
    for raw in _LD_RE.findall(html):
        m = _PRIM_IMG_KEY.search(raw)
        if not m:
            continue
        url = m.group(1).strip()
        if url and not url.startswith("data:") and "gravatar.com" not in url:
            return url, None

    # Fallback: first article <img data-src=> that isn't the logo / blank gif
    for m in re.finditer(r'data-src="([^"]+\.(?:jpg|jpeg|png|webp))"', html, re.IGNORECASE):
        url = m.group(1)
        if any(skip in url.lower() for skip in ("logo", "blank.gif", "favicon", "gravatar")):
            continue
        return url, None
    return None, None


# ---------- Importers ----------

def import_categories(dry_run=False):
    wp_cats = wp_paginated("categories")
    print(f"WP categories: {len(wp_cats)}")
    # WP -> Strapi documentId map (built as we upsert)
    wp_to_doc: dict[int, str] = {}
    parent_pending: list[tuple[dict, int]] = []  # (created strapi cat, wp_parent_id)

    for c in wp_cats:
        legacy_id = c["id"]
        payload = {
            "data": {
                "name": c["name"],
                "slug": c["slug"],
                "description": (c.get("description") or "").strip()[:1000] or None,
                "legacyWpId": legacy_id,
                "order": 100 - c.get("count", 0),
            }
        }
        # Remove None values so Strapi keeps defaults
        payload["data"] = {k: v for k, v in payload["data"].items() if v is not None}

        existing = find_category(legacy_id)
        if existing:
            doc_id = existing["documentId"]
            if dry_run:
                print(f"  [dry] would update category #{legacy_id} {c['slug']} (docId {doc_id})")
            else:
                code, res = strapi("PUT", f"/nxtsmart-categories/{doc_id}", payload)
                if code not in (200, 201):
                    print(f"  ! update failed {legacy_id} {c['slug']}: {code} {str(res)[:200]}")
                    continue
                print(f"  ~ updated   {c['slug']:<40} docId {doc_id}")
            wp_to_doc[legacy_id] = doc_id
        else:
            if dry_run:
                print(f"  [dry] would create category #{legacy_id} {c['slug']}")
            else:
                code, res = strapi("POST", "/nxtsmart-categories", payload)
                if code not in (200, 201):
                    print(f"  ! create failed {legacy_id} {c['slug']}: {code} {str(res)[:200]}")
                    continue
                doc_id = res["data"]["documentId"]
                wp_to_doc[legacy_id] = doc_id
                print(f"  + created   {c['slug']:<40} docId {doc_id}")
        if c.get("parent"):
            parent_pending.append((wp_to_doc.get(legacy_id), c["parent"]))

    # Second pass: set parent relations
    for own_doc, wp_parent in parent_pending:
        if not own_doc or wp_parent not in wp_to_doc:
            continue
        parent_doc = wp_to_doc[wp_parent]
        if dry_run:
            print(f"  [dry] would set parent {own_doc} -> {parent_doc}")
            continue
        code, res = strapi(
            "PUT",
            f"/nxtsmart-categories/{own_doc}",
            {"data": {"parent": parent_doc}},
        )
        if code not in (200, 201):
            print(f"  ! parent link failed {own_doc}: {code} {str(res)[:200]}")

    return wp_to_doc


def import_posts(category_map: dict[int, str] | None = None, limit: int | None = None, dry_run=False):
    if category_map is None:
        # Build map from existing Strapi categories
        category_map = {}
        page = 1
        while True:
            code, res = strapi(
                "GET",
                f"/nxtsmart-categories?fields[0]=legacyWpId&pagination[page]={page}&pagination[pageSize]=100",
            )
            if code != 200 or not res.get("data"):
                break
            for cat in res["data"]:
                if cat.get("legacyWpId"):
                    category_map[cat["legacyWpId"]] = cat["documentId"]
            if len(res["data"]) < 100:
                break
            page += 1

    wp_posts = wp_paginated("posts", extra={"status": "publish", "orderby": "date", "order": "asc"})
    print(f"WP posts: {len(wp_posts)}")
    if limit:
        wp_posts = wp_posts[:limit]
        print(f"  (limited to {limit})")

    created = updated = skipped = failed = 0
    for i, p in enumerate(wp_posts, 1):
        legacy_id = p["id"]
        slug = p["slug"]
        title = (p.get("title", {}).get("rendered") or slug).strip()
        # WP returns HTML-encoded titles, normalize entity-encoded chars
        title = title.replace("&amp;", "&").replace("&#8217;", "'").replace("&#8211;", "-").replace("&#8216;", "'").replace("&#8220;", '"').replace("&#8221;", '"').replace("&hellip;", "...").replace("&nbsp;", " ")
        if len(title) > 255:
            title = title[:252] + "..."

        excerpt_html = p.get("excerpt", {}).get("rendered") or ""
        excerpt = re.sub(r"<[^>]+>", "", excerpt_html).strip()
        excerpt = re.sub(r"\s+", " ", excerpt)[:500]

        content = p.get("content", {}).get("rendered") or ""

        # Map categories
        cat_doc_ids = []
        post_type = "informative"
        for wp_cat_id in p.get("categories", []):
            doc = category_map.get(wp_cat_id)
            if doc:
                cat_doc_ids.append(doc)

        # Determine postType from first known WP category
        for wp_cat_id in p.get("categories", []):
            cat_legacy = wp_cat_id
            # find its slug from category_map (we only have docId -> need slug). Need to refetch or pre-cache.
            # Skip — we'll re-resolve postType below from a fresh slug lookup
            break

        # Resolve post type from category slugs (small list, cheap to refetch)
        # For perf we resolve once per category from a cache
        post_type = resolve_post_type(p.get("categories", []), category_slug_cache)

        # Featured image
        cover_url, cover_alt = extract_cover_image(p["link"])

        # Reading time: ~225 wpm
        text_only = re.sub(r"<[^>]+>", " ", content)
        words = len(re.findall(r"\w+", text_only))
        reading_minutes = max(1, round(words / 225))

        data = {
            "title": title,
            "slug": slug[:255],
            "excerpt": excerpt or None,
            "content": content,
            "postType": post_type,
            "sourceUrl": p.get("link"),
            "legacyWpId": legacy_id,
            "readingTimeMinutes": reading_minutes,
            "source": "wp-import",
            "seoTitle": title[:70],
            "seoDescription": excerpt[:160] if excerpt else None,
        }
        if p.get("date_gmt"):
            # Strapi will ignore this on create (v5 quirk), but we keep it for
            # any code path that does respect it. Real backfill happens via SQL.
            data["publishedAt"] = f"{p['date_gmt']}.000Z"
            published_at_backfill[legacy_id] = f"{p['date_gmt']}+00"
        if cover_url:
            data["coverImageUrl"] = cover_url
            if cover_alt:
                data["coverImageAlt"] = cover_alt
        if cat_doc_ids:
            data["categories"] = cat_doc_ids
        data = {k: v for k, v in data.items() if v is not None}
        payload = {"data": data}

        existing = find_post(legacy_id)
        action = "update" if existing else "create"
        if dry_run:
            print(f"  [{i}/{len(wp_posts)}] [dry] {action} #{legacy_id} {slug[:60]} cover={'Y' if cover_url else '-'}")
            continue

        if existing:
            doc_id = existing["documentId"]
            code, res = strapi("PUT", f"/nxtsmart-posts/{doc_id}", payload)
            if code in (200, 201):
                updated += 1
                marker = "~"
            else:
                failed += 1
                marker = "!"
        else:
            code, res = strapi("POST", "/nxtsmart-posts", payload)
            if code in (200, 201):
                created += 1
                marker = "+"
            else:
                failed += 1
                marker = "!"
        err = "" if code in (200, 201) else f" :: {code} {str(res)[:150]}"
        print(f"  [{i:>3}/{len(wp_posts):<3}] {marker} {slug[:70]:<70} cover={'Y' if cover_url else '-'}{err}")

    print(f"\nDone. created={created} updated={updated} failed={failed}")
    if not dry_run:
        print("\nBackfilling publishedAt from WP date_gmt values...")
        backfill_published_at()


# Build a (wp_cat_id -> slug) cache by listing Strapi categories
category_slug_cache: dict[int, str] = {}

# Strapi v5 ignores `publishedAt` on create. We collect WP date_gmt values
# and patch them after the import via a single SQL UPDATE on the postgres DB
# (mirrors the pattern used by /strapi-deploy/scripts/import-nxt-bargains.mjs).
published_at_backfill: dict[int, str] = {}


def _load_env_kv(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                v = v.strip().strip('"').strip("'")
                out[k.strip()] = v
    except OSError:
        pass
    return out


def backfill_published_at():
    """Patch nxtsmart_posts.published_at from WP date_gmt values.

    Only touches the published rows (`published_at IS NOT NULL`); leaving the
    paired draft rows alone keeps entries visible in the Strapi admin UI.
    """
    if not published_at_backfill:
        return
    env = _load_env_kv("/opt/fxn-cms-git/backend/strapi-deploy/.env")
    db_name = env.get("DATABASE_NAME")
    db_user = env.get("DATABASE_USERNAME")
    if not (db_name and db_user):
        print("  [warn] DB creds not found in strapi-deploy/.env; skipping publishedAt backfill")
        return
    cases = []
    ids = []
    for legacy_id, ts in published_at_backfill.items():
        cases.append(f"WHEN legacy_wp_id = {int(legacy_id)} THEN '{ts}'::timestamp")
        ids.append(int(legacy_id))
    sql = (
        "UPDATE nxtsmart_posts "
        f"SET published_at = CASE {' '.join(cases)} END "
        f"WHERE published_at IS NOT NULL AND legacy_wp_id IN ({','.join(map(str, ids))});"
    )
    try:
        out = subprocess.check_output(
            ["docker", "exec", "-i", "fxn-postgres", "psql", "-U", db_user, "-d", db_name, "-c", sql],
            text=True,
            timeout=60,
        )
        print(f"  publishedAt backfill: {out.strip()}")
    except subprocess.CalledProcessError as e:
        print(f"  [warn] publishedAt backfill failed: {e}")


def populate_category_slug_cache():
    page = 1
    while True:
        code, res = strapi(
            "GET",
            f"/nxtsmart-categories?fields[0]=legacyWpId&fields[1]=slug&pagination[page]={page}&pagination[pageSize]=100",
        )
        if code != 200 or not res.get("data"):
            break
        for cat in res["data"]:
            if cat.get("legacyWpId") and cat.get("slug"):
                category_slug_cache[cat["legacyWpId"]] = cat["slug"]
        if len(res["data"]) < 100:
            break
        page += 1


def resolve_post_type(wp_cat_ids: list[int], slug_cache: dict[int, str]) -> str:
    for cid in wp_cat_ids:
        slug = slug_cache.get(cid)
        if slug and slug in POST_TYPE_BY_CATEGORY_SLUG:
            return POST_TYPE_BY_CATEGORY_SLUG[slug]
    return "informative"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="Cap posts processed")
    ap.add_argument("--posts-only", action="store_true")
    ap.add_argument("--categories-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.posts_only:
        print("=== categories ===")
        import_categories(dry_run=args.dry_run)
    if not args.categories_only:
        print("\n=== posts ===")
        populate_category_slug_cache()
        import_posts(limit=args.limit, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
