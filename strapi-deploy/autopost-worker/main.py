"""
Autopost worker — polls Strapi for articles with scheduled destinations
and pushes them to configured blog-destinations on their cadence.

Runs as a sidecar container. Exposes /healthz and /trigger for manual runs.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import FastAPI, HTTPException
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    strapi_url: str = "http://strapi:1337"
    strapi_api_token: str = ""
    scheduler_interval_seconds: int = 60
    timezone: str = "UTC"
    log_level: str = "INFO"


settings = Settings(_env_file=None)  # pydantic-settings auto-reads env
logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("autopost")

app = FastAPI(title="FXN Autopost Worker", version="1.0.0")
scheduler = AsyncIOScheduler(timezone=settings.timezone)


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.strapi_api_token}"}


def _schedule_matches_now(schedule: str, now: datetime) -> bool:
    """Return True if we should post to a destination with this schedule right now."""
    if schedule == "immediate":
        return False  # handled by Strapi lifecycle
    if schedule == "hourly":
        return now.minute == 0
    if schedule == "daily-0900":
        return now.hour == 9 and now.minute == 0
    if schedule == "daily-1800":
        return now.hour == 18 and now.minute == 0
    return False  # "manual" — never auto


async def _fetch_pending_articles(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Fetch articles that are published and have pending autopost."""
    params = {
        "filters[publishedAt][$notNull]": "true",
        "filters[autopostStatus][$in][0]": "pending",
        "filters[autopostStatus][$in][1]": "none",
        "populate[blogDestinations]": "*",
        "populate[category]": "*",
        "populate[tags]": "*",
        "populate[destinations]": "*",
        "populate[author]": "*",
        "populate[coverImage]": "*",
        "pagination[pageSize]": "50",
    }
    r = await client.get(
        f"{settings.strapi_url}/api/articles",
        params=params,
        headers=_auth_headers(),
        timeout=20.0,
    )
    r.raise_for_status()
    payload = r.json()
    return payload.get("data", [])


async def _update_article_log(
    client: httpx.AsyncClient,
    article_id: int,
    status: str,
    log_entries: list[dict[str, Any]],
) -> None:
    await client.put(
        f"{settings.strapi_url}/api/articles/{article_id}",
        json={"data": {"autopostStatus": status, "autopostLog": log_entries}},
        headers={**_auth_headers(), "Content-Type": "application/json"},
        timeout=20.0,
    )


async def _post_to_destination(
    client: httpx.AsyncClient, article: dict[str, Any], dest: dict[str, Any]
) -> dict[str, Any]:
    a = article.get("attributes", article)
    payload = {
        "event": "article.scheduled",
        "article": {
            "id": article.get("id"),
            "title": a.get("title"),
            "slug": a.get("slug"),
            "excerpt": a.get("excerpt"),
            "content": a.get("content"),
            "publishedAt": a.get("publishedAt"),
        },
    }
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    secret = dest.get("webhookSecret")
    if secret:
        headers["X-FXN-Signature"] = hmac.new(
            secret.encode(), body, hashlib.sha256
        ).hexdigest()
    if dest.get("authHeader"):
        headers["Authorization"] = dest["authHeader"]

    r = await client.post(
        dest["webhookUrl"], content=body, headers=headers, timeout=20.0
    )
    return {
        "destination": dest.get("name"),
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "posted" if r.is_success else "failed",
        "http": r.status_code,
    }


async def tick() -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    log.info("tick at %s", now.isoformat())

    async with httpx.AsyncClient() as client:
        articles = await _fetch_pending_articles(client)
        summary = {"checked": len(articles), "posted": 0, "failed": 0}

        for art in articles:
            attrs = art.get("attributes", art)
            dests = attrs.get("blogDestinations", {}).get("data", []) or attrs.get(
                "blogDestinations", []
            )
            existing_log = attrs.get("autopostLog") or []
            new_log = list(existing_log) if isinstance(existing_log, list) else []
            overall = "posted"
            any_posted = False

            for d in dests:
                d_attrs = d.get("attributes", d)
                if not d_attrs.get("active") or not d_attrs.get("autoPostOnPublish"):
                    continue
                if not _schedule_matches_now(d_attrs.get("schedule", "manual"), now):
                    continue
                # avoid reposting — if an entry exists for this destination in last 23h
                already = any(
                    e.get("destination") == d_attrs.get("name")
                    and e.get("status") == "posted"
                    for e in new_log[-20:]
                )
                if already and d_attrs.get("schedule") != "hourly":
                    continue

                try:
                    entry = await _post_to_destination(client, art, d_attrs)
                    new_log.append(entry)
                    if entry["status"] == "posted":
                        summary["posted"] += 1
                        any_posted = True
                    else:
                        summary["failed"] += 1
                        overall = "failed"
                except Exception as e:  # noqa
                    summary["failed"] += 1
                    overall = "failed"
                    new_log.append(
                        {
                            "destination": d_attrs.get("name"),
                            "at": now.isoformat(),
                            "status": "failed",
                            "error": str(e)[:500],
                        }
                    )

            if any_posted or overall == "failed":
                try:
                    await _update_article_log(client, art["id"], overall, new_log)
                except Exception as e:  # noqa
                    log.warning("failed to update log for article %s: %s", art["id"], e)

    log.info("tick done: %s", summary)
    return summary


@app.on_event("startup")
async def _startup() -> None:
    if not settings.strapi_api_token:
        log.warning("AUTOPOST_STRAPI_TOKEN is empty — worker cannot authenticate.")
    scheduler.add_job(
        tick,
        trigger=IntervalTrigger(seconds=settings.scheduler_interval_seconds),
        id="autopost-tick",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()
    log.info("scheduler started — interval=%ss", settings.scheduler_interval_seconds)


@app.on_event("shutdown")
async def _shutdown() -> None:
    scheduler.shutdown(wait=False)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "strapi_url": settings.strapi_url,
        "scheduler_running": scheduler.running,
        "interval_seconds": settings.scheduler_interval_seconds,
    }


@app.post("/trigger")
async def trigger() -> dict[str, Any]:
    """Manual trigger for testing."""
    if not settings.strapi_api_token:
        raise HTTPException(503, "AUTOPOST_STRAPI_TOKEN not configured")
    return await tick()
