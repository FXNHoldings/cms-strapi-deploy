# FXN Studio — Travel CMS (Strapi 5 on Hetzner)

Turn-key deployment package for `cms.fxnstudio.com`: a Strapi 5 headless CMS
with two custom plugins (AI Writer — Claude Sonnet 4.5, and Bulk Import —
Markdown + CSV) plus a FastAPI auto-post worker that syndicates articles to
external blog destinations on a schedule.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Hetzner CX22 (Ubuntu 24.04)                  │
│                                                                 │
│   ┌──────────┐   ┌───────────────┐   ┌──────────────────────┐   │
│   │  Caddy   │──►│  Strapi 5     │──►│   PostgreSQL 16      │   │
│   │ (TLS ACME│   │ + ai-writer   │   │                      │   │
│   │   :443)  │   │ + bulk-import │   └──────────────────────┘   │
│   └────▲─────┘   └──────┬────────┘                              │
│        │                │                                       │
│        │         ┌──────▼──────────────────┐                    │
│        └─────────┤  autopost-worker (Py)   │                    │
│                  │  FastAPI + APScheduler  │                    │
│                  └─────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
                         ▲            ▲
                         │            │
              https://cms.fxnstudio.com (admin + REST/GraphQL)
              https://www.fxnstudio.com  (travel blog — next phase)
```

## What's in the box

| Path | Purpose |
|------|---------|
| `docker-compose.yml` | Orchestrates Strapi + Postgres + Caddy + autopost-worker |
| `Caddyfile` | Auto-HTTPS reverse proxy for `cms.fxnstudio.com` + `www.fxnstudio.com` |
| `.env.example` | All env vars — copy to `.env` and fill in |
| `strapi/` | Strapi 5 app (content types, config, two custom plugins) |
| `autopost-worker/` | FastAPI sidecar that pushes scheduled posts to destinations |
| `scripts/` | Server bootstrap, secret generation, backup/restore |

## Content types
- **Article** — title, slug, content, cover, gallery, SEO, category, tags, author, destinations, blog-destinations, autopost status & log, source (manual / ai / markdown-import / csv-import)
- **Category** — top-level taxonomy (Flights, Hotels, Tips, Destinations …)
- **Destination** — country / region / city with hero image
- **Tag** — free-form taxonomy
- **Author** — editor profiles
- **Blog Destination** — external syndication target with webhook URL, HMAC secret, schedule (immediate / hourly / daily-0900 / daily-1800 / manual)

## Custom plugins
### AI Writer (Claude Sonnet 4.5)
`/admin → AI Writer` — generate a full SEO-ready draft from a topic. Creates
a draft `Article` you can review, attach media, link destinations, and publish.
Uses `claude-sonnet-4-5-20250929` by default (`CLAUDE_MODEL` env to override).

### Bulk Import (Markdown + CSV)
`/admin → Bulk Import` — upload `.md` files (with YAML frontmatter) or a CSV.
Unknown categories, tags, destinations and authors are auto-created.

## Autopost flow
1. Editor links an article to one or more **Blog Destinations** and publishes.
2. Destinations with `schedule = immediate` are fired by Strapi's lifecycle
   hook via webhook immediately (HMAC-signed if `webhookSecret` is set).
3. Destinations with `hourly` / `daily-0900` / `daily-1800` are queued as
   `pending`. The `autopost-worker` polls every 60s and dispatches on cadence.
4. Every dispatch appends a line to `autopost.autopostLog` for audit.

## Quick start

```bash
# 1. On your dev machine
git clone <this-repo> fxn-cms && cd fxn-cms
./scripts/generate-secrets.sh > secrets.env
cp .env.example .env
cat secrets.env >> .env            # merge generated secrets
# Fill in ANTHROPIC_API_KEY and (later) AUTOPOST_STRAPI_TOKEN

# 2. Push to your Hetzner server and start
docker compose up -d --build

# 3. Open https://cms.fxnstudio.com/admin and create the first admin user
```

Full step-by-step guide for the Hetzner provisioning is in **[DEPLOYMENT.md](./DEPLOYMENT.md)**.
