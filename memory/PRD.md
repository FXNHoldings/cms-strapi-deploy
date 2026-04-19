# FXN Studio — Travel CMS + Blog (PRD)

## Original problem statement
Build a centralised CMS for articles/products for small-to-medium businesses,
easy to use, supports multi-method content import, AI-assisted generation,
and syndicates blog posts to multiple destination websites. Also build a
compatible travel blog (flights, hotels, travel info).

## Architecture (agreed)
- **Core CMS:** Strapi 5 (headless, Node.js + React admin), self-hosted
- **Host:** Hetzner CX22 (Ubuntu 24.04, 2 vCPU / 4 GB / 40 GB)
- **DB:** Self-hosted PostgreSQL 16 in Docker Compose
- **Media:** local volume (upgrade to Cloudflare R2 later)
- **Reverse proxy + TLS:** Caddy 2 (auto Let's Encrypt)
- **AI provider:** Anthropic Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) — user-supplied API key
- **Autopost engine:** FastAPI + APScheduler sidecar (60s tick)
- **Domain:** `cms.fxnstudio.com` (admin/API) + `www.fxnstudio.com` (blog — next phase)
- **Blog frontend:** Next.js on Vercel — DEFERRED until CMS is live

## User personas
1. **SMB editor/owner** — creates/publishes articles, uses AI Writer and Bulk Import, manages categories/destinations
2. **Developer** — manages the server, API tokens, blog-destinations config, monitors autopost
3. **End reader** — visits the travel blog (www.fxnstudio.com, next phase)

## Core requirements (static)
- Multi-method import (manual editor + Markdown + CSV)
- AI-assisted generation with SEO metadata
- Multi-destination syndication with schedule & HMAC-signed webhooks
- Role-based access (Strapi built-in)
- Media library
- Draft & publish workflow
- SEO fields per article
- Audit log of autopost dispatches

## What's been implemented (2026-02-14)
- Docker Compose orchestrating Strapi 5 + Postgres 16 + Caddy + autopost-worker
- Caddyfile for auto-TLS on `cms.fxnstudio.com` + `www.fxnstudio.com`
- Strapi 5 Dockerfile (multi-stage, Node 20 alpine, vips for sharp)
- 6 content types with relations & lifecycles: Article (with autopost lifecycle webhook), Category, Destination, Tag, Author, Blog-destination
- **AI Writer plugin** (admin page + `/ai-writer/generate` endpoint using Claude Sonnet 4.5)
- **Bulk Import plugin** (admin page + `/bulk-import/markdown` + `/bulk-import/csv` endpoints, auto-resolves categories/tags/destinations/authors)
- **FastAPI autopost worker** — polls `/api/articles` every 60s, dispatches HMAC-signed webhooks on schedule, updates autopost audit log
- Hetzner server-provisioning script (Docker, UFW, fail2ban, deploy user, SSH hardening)
- Secrets generation, backup, restore scripts
- README.md, DEPLOYMENT.md (step-by-step), PLUGINS.md, AUTOPOST.md
- Sample Markdown + CSV for bulk-import fixtures

## Verification done
- Python worker: ruff-clean, FastAPI app imports, `/healthz` returns 200
- All JSON schemas valid
- Strapi package.json resolves (yarn install OK)

## Deferred / next (prioritised)
- **P0** — User to deploy: provision Hetzner CX22, point DNS, run `docker compose up -d`, create admin, generate API token, populate `.env`
- **P0** — Once CMS is live, build **Next.js travel blog frontend** on Vercel (sections: Home, Flights, Hotels, Destinations, Tips, Article detail, Destination page, Search)
- **P1** — Cloudflare R2 upload provider for Strapi media
- **P1** — RSS feed ingestion in Bulk Import
- **P1** — URL scraping import (paste URL → extract article)
- **P1** — Image generation (Nano Banana) for article heroes
- **P2** — Retry/backoff queue (Celery or BullMQ) in autopost worker
- **P2** — Newsletter capture + deals alert
- **P2** — Products content type (if monetisation via affiliate deals)

## File locations
- Deployment package: `/app/backend/strapi-deploy/` (93 files, moved from `/app/strapi-deploy/` so Emergent's Save to GitHub sync includes it)
- Blog frontend: *not yet created — pending CMS being live*
