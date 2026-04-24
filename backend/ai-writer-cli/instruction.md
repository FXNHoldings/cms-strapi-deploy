# FXN AI Writer CLI — Instructions & Command Reference

Six scripts live in this directory. Each one is a standalone Node.js tool that either **ingests** factual data, **enriches** existing Strapi records, or **generates** new content with Claude. All of them talk to the same Strapi instance via `STRAPI_URL` + `STRAPI_API_TOKEN` in `.env`.

---

## Quick start

```bash
cd backend/ai-writer-cli
cp .env.example .env    # fill in ANTHROPIC_API_KEY, STRAPI_URL, STRAPI_API_TOKEN, (optional) FAL_KEY
npm install
```

Recommended order for a fresh Strapi:

1. **ingest-travelpayouts.js** — bulk-load airports, airlines, and routes from the free TP data dumps.
2. **enrich-countries.js** — fill in country names on the ingested airports.
3. **enrich-airlines.js** — backfill corporate fields (website, phone, legal name, address) on airlines.
4. **generate-destinations.js** — create destination entries (cities / regions / countries).
5. **generate-airlines.js** — only if you want richer airline profiles written by Claude (skip if TP ingest + enrichment is enough).
6. **generate.js** — write blog articles, drafted or published.

Every script supports `--dry-run` so you can see what it would do before writing anything.

---

## 1. `ingest-travelpayouts.js` — Bulk import airports / airlines / routes

Pulls the public TravelPayouts JSON dumps and upserts into Strapi. Safe to re-run (skips existing by IATA/slug). No API key needed — the TP data endpoints are public.

Source: `https://api.travelpayouts.com/data/en/*.json`

### Commands

```bash
# Default — countries + airports + airlines + top 500 routes
node ingest-travelpayouts.js

# Just one collection
node ingest-travelpayouts.js --countries-only
node ingest-travelpayouts.js --airports-only
node ingest-travelpayouts.js --airlines-only
node ingest-travelpayouts.js --routes-only --route-limit 1000

# Cap airports (0 = all commercial ones, which is several thousand)
node ingest-travelpayouts.js --airport-limit 500

# Force fresh download (ignore the local cache in /tmp/tp-ingest-cache)
node ingest-travelpayouts.js --refresh

# Preview without writing
node ingest-travelpayouts.js --dry-run

# Skip logo fetching for new airlines
node ingest-travelpayouts.js --no-with-logos
```

### Key flags

| Flag | Default | Purpose |
|---|---|---|
| `--countries-only`, `--airports-only`, `--airlines-only`, `--routes-only` | `false` | Narrow to one collection |
| `--route-limit <n>` | `500` | Cap routes (by popularity). `0` = no cap |
| `--airport-limit <n>` | `0` | Cap airports |
| `--refresh` | `false` | Re-download TP dumps |
| `--concurrency <n>` | `6` | Parallel Strapi writes |
| `--with-logos` | `true` | Fetch airline logos via `pics.avs.io` |
| `--dry-run` | `false` | No writes |

---

## 2. `enrich-countries.js` — Fill country names on airports

The TP airport dump only has `countryCode` (two-letter). This script joins that against TravelPayouts' countries.json so each airport record gets a full `country` name and `currency`. Idempotent — only touches airports missing a country name.

### Commands

```bash
# Small test batch first
node enrich-countries.js --limit 10 --dry-run

# Full run (all airports missing a country)
node enrich-countries.js

# Also backfill airlines (name-based matching — imprecise, see script notes)
node enrich-countries.js --airlines

# Re-download the countries.json dump
node enrich-countries.js --refresh
```

### Key flags

| Flag | Default | Purpose |
|---|---|---|
| `--limit <n>` | `0` (all) | Cap how many airport records to process |
| `--airlines` | `false` | Also backfill airlines (matches on name hints) |
| `--concurrency <n>` | `6` | Parallel writes |
| `--refresh` | `false` | Re-download countries.json |
| `--dry-run` | `false` | No writes |

---

## 3. `enrich-airlines.js` — Backfill airline corporate fields

Backfills `legalName`, `address`, `phone`, `website` (and gaps in `iataCode` / `icaoCode` / `country` / `region`) on airlines already in Strapi. Two-stage pipeline:

1. **Wikidata** (primary, free, structured) — SPARQL lookup by IATA (P229) or ICAO (P230).
2. **Claude + `web_search`** (fallback) — only for fields still empty after Wikidata. Claude returns strict JSON with a `source_url` per field.

Idempotent and resumable — a checkpoint file `.enrich-airlines.progress.json` tracks processed airlines.

### Commands

```bash
# All airlines with any empty target field (wikidata first, then Claude fallback)
node enrich-airlines.js

# One airline
node enrich-airlines.js --iata SQ

# Only specific fields
node enrich-airlines.js --fields website,phone -n 25

# Skip Claude (Wikidata only — free, no API spend)
node enrich-airlines.js --source wikidata

# Only Claude (skip Wikidata)
node enrich-airlines.js --source claude --iata QF

# Overwrite existing values instead of only filling empty ones
node enrich-airlines.js --overwrite --iata SQ

# Preview the diffs, no writes
node enrich-airlines.js -n 10 --dry-run

# Restart from zero, ignoring the checkpoint
node enrich-airlines.js --no-resume
```

### Key flags

| Flag | Default | Purpose |
|---|---|---|
| `--fields <csv>` | `website,phone,legalName,address` | Which fields to enrich |
| `--source <wikidata\|claude\|both>` | `both` | Which stage(s) to run |
| `--iata <code>` | — | Target one airline |
| `-n, --limit <n>` | `0` (all) | Cap batch size |
| `--overwrite` | `false` | Replace existing values |
| `--concurrency <n>` | `3` | Parallel airlines (keep ≤4 for Wikidata rate limits) |
| `--resume` / `--no-resume` | `true` | Skip airlines already in checkpoint |
| `--dry-run` | `false` | Print diff, no writes |

Model defaults to `claude-sonnet-4-6` (higher TPM than Opus, fine for structured lookup). Override with `ENRICH_CLAUDE_MODEL=claude-opus-4-7` in `.env`.

---

## 4. `generate-destinations.js` — Create destination entries with Claude

Generates Destination records (city, region, or country) with Claude Sonnet 4.5, optional hero image via Fal.ai FLUX, and posts to Strapi's `/api/destinations`.

### Commands

```bash
# Interactive — prompts for type, count, scope, images
node generate-destinations.js

# Cities in Japan
node generate-destinations.js --type city --count 10 --scope "Japan"

# Countries, no images (faster, cheaper)
node generate-destinations.js --type country -n 5 --no-images

# Regions in Asia
node generate-destinations.js --type region -n 6 --scope "Asia"

# Preview
node generate-destinations.js --type city -n 5 --scope "Thailand" --dry-run
```

### Key flags

| Flag | Default | Purpose |
|---|---|---|
| `--type <country\|region\|city>` | — (required if non-interactive) | Destination type |
| `-n, --count <n>` | — | How many to generate |
| `--scope <string>` | — | Geographic scope ("Southeast Asia", "Japan") |
| `--tone <name>` | `friendly` | `friendly`, `professional`, `adventurous`, `witty`, `luxury` |
| `--language` | `English` | Output language |
| `--images` / `--no-images` | `true` | Fal.ai hero image |
| `--image-model <schnell\|dev\|pro>` | `schnell` | FLUX variant |
| `-i, --interactive` | `false` | Force interactive prompts |
| `--dry-run` | `false` | No writes |

---

## 5. `generate-airlines.js` — Create airline directory entries with Claude

Generates Airline entries with Claude Opus and posts to Strapi. Logos are **not** generated (trademarks) — they're fetched from TravelPayouts by IATA code. Also has two backfill modes for existing records.

### Commands

```bash
# Interactive
node generate-airlines.js

# 10 Asia-Pacific airlines
node generate-airlines.js --region "Asia-Pacific" --count 10

# 5 specific airlines by name
node generate-airlines.js --names "Singapore Airlines, Qantas, Emirates"

# Low-cost carriers in Europe
node generate-airlines.js --type "Low-cost" -n 8 --region Europe

# Try to attach logos for airlines already in Strapi that lack one
node generate-airlines.js --backfill-logos

# Fill in missing countries on existing airlines (Claude-based guess from name/IATA)
node generate-airlines.js --backfill-countries

# Preview
node generate-airlines.js --names "Singapore Airlines, Qantas" --dry-run
```

### Key flags

| Flag | Default | Purpose |
|---|---|---|
| `--region <name>` | — | `Oceania`, `Asia-Pacific`, `Europe`, `Americas`, `Middle East`, `Africa` |
| `--type <name>` | — | `Scheduled`, `Charter`, `Cargo`, `Low-cost`, `Regional` |
| `-n, --count <n>` | — | How many to generate |
| `--names <csv>` | — | Specific airlines to generate (bypasses brainstorm) |
| `--language` | `English` | |
| `--logos` / `--no-logos` | `true` | Fetch logos from TP |
| `--backfill-logos` | `false` | Iterate existing airlines missing a logo |
| `--backfill-countries` | `false` | Iterate airlines missing a country, ask Claude |
| `-i, --interactive` | `false` | Force prompts |
| `--dry-run` | `false` | No writes |

---

## 6. `generate.js` — Write blog articles

The main content generator. Three modes:

1. **Fully auto** — pick a category and count, Claude brainstorms titles AND writes them.
2. **Interactive** — no args, it prompts.
3. **Manual topics** — you supply the titles (single, batch file, or auto-fill preset).

Each article comes out as: title, slug, excerpt, Markdown content, SEO fields, tags, reading time. Optionally cover + 2 gallery images via Fal.ai.

### Commands

```bash
# Fully auto — Claude brainstorms 5 Flights titles and writes them
node generate.js --category flights --count 5

# Published immediately (default is draft)
node generate.js -c hotels -n 10 --publish

# Interactive
node generate.js

# Single manual topic
node generate.js "Cheap flights London to Bangkok" --category flights

# Batch from a topics.txt file (format: "category | topic" per line)
node generate.js --topics topics.txt

# Cap how many lines of the file to process
node generate.js --topics topics.txt --count 5

# 6 categories × 6 preset topics (quick smoke test)
node generate.js --auto-fill

# No images (faster, cheaper)
node generate.js -c travel-tips -n 5 --no-images

# Draft mode (default) — writes to Strapi as unpublished drafts
node generate.js -c hotels -n 3

# Preview only
node generate.js -c flights -n 3 --dry-run
```

### Topic file format

```
# Lines starting with # are comments
category | topic
category | topic
```

- Categories are looked up by slug first, then by case-insensitive name. Missing categories are auto-created.
- Empty topics (`category |` with nothing after) are skipped.
- Destinations are **auto-detected from the title** against Strapi's destinations collection — e.g., `hotels | 5 boutique hotels in Chiang Mai` attaches the Chiang Mai destination automatically.

### Key flags

| Flag | Default | Purpose |
|---|---|---|
| `-t, --topic <string>` | — | Single article title |
| `--topics <file>` | — | Batch file |
| `--auto-fill` | `false` | 6 preset categories × 6 topics |
| `-c, --category <slug>` | — | Target category (required unless per-line) |
| `-n, --count <n>` | — | How many articles (or cap in `--topics` mode) |
| `-d, --destination <csv>` | — | Explicit destination(s) to attach |
| `--auto-destinations` | `true` | Auto-attach by matching title against destinations |
| `--tone <name>` | `friendly` | `friendly`, `professional`, `adventurous`, `witty`, `luxury` |
| `-l, --length <short\|medium\|long>` | `long` | 400-600 / 800-1200 / 1500-2200 words |
| `-k, --keywords <string>` | — | Keywords to weave in |
| `--language` | `English` | |
| `--publish` | `false` | Publish vs. save as draft |
| `--images` / `--no-images` | `true` | Generate cover + 2 gallery images |
| `--image-model <schnell\|dev\|pro>` | `schnell` | Fal.ai FLUX variant |
| `-i, --interactive` | `false` | Force prompts |
| `--dry-run` | `false` | No writes |

---

## Environment variables

Put these in `.env` (copy `.env.example` first):

| Var | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes (for generate.js, generate-*, enrich-airlines.js Claude stage) | Claude API |
| `STRAPI_URL` | yes (unless `--dry-run`) | e.g. `https://cms.fxnstudio.com` |
| `STRAPI_API_TOKEN` | yes (unless `--dry-run`) | Full-access Strapi token |
| `FAL_KEY` | only if generating images | Fal.ai image generation |
| `CLAUDE_MODEL` | no | Override model for `generate.js` / `generate-*` (default: `claude-sonnet-4-5-20250929`) |
| `ENRICH_CLAUDE_MODEL` | no | Override model for `enrich-airlines.js` Claude fallback (default: `claude-sonnet-4-6`) |
| `WIKIDATA_USER_AGENT` | no | Sent to Wikidata SPARQL endpoint (required by their policy; script has a default) |

---

## Safety checklist before a big run

1. Always `--dry-run` first.
2. Start with `--limit 5` or `-n 5` to confirm the output shape.
3. For anything that writes to Strapi, check you can roll back — a fresh Strapi backup before your first big ingest is cheap insurance.
4. For Claude-powered steps, watch the first 10 results manually. Models hallucinate confidently on obscure names, prices, and phone numbers.
5. The `enrich-airlines.js` script has a per-field `source_url` logged when Claude fills a value — use that as your audit trail.
