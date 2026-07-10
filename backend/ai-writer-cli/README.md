# FXN AI Writer CLI

A tiny standalone Node.js tool that generates full articles with **OpenAI by default** and posts them as **drafts** to your Strapi CMS. OpenRouter and Anthropic Claude are also available through `AI_PROVIDER`.

Drafts appear in Strapi → you review, attach a cover image and destinations → publish.

## Prerequisites

- Node.js 20+ on whatever machine you run this from (your laptop is fine)
- An OpenAI API key — set it as `OPENAI_API_KEY`
- Or an OpenRouter API key — set `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY`
- Optional Anthropic API key if using `AI_PROVIDER=anthropic`
- A Strapi **API Token** with write permission for Articles **and** Upload
  - In Strapi admin → **Settings → API Tokens → Create new API Token**
  - Name: `ai-writer-cli`
  - Type: **Full access** (or Custom with `article: create` + `upload: create`)
  - Duration: Unlimited (or as you prefer)
  - Copy the token value immediately (shown once)
- (Optional but recommended) A **Fal.ai** API key for automatic featured + gallery images
  - Get one at https://fal.ai/dashboard/keys
  - Skip with `--no-images` if you prefer text-only drafts

## Install

```bash
cd backend/ai-writer-cli
cp .env.example .env
# Edit .env — paste your ANTHROPIC_API_KEY and STRAPI_API_TOKEN
nano .env

npm install    # or: yarn install / pnpm install
```

## Quickest way — let AI invent the titles AND write them

Just pick a category and how many articles you want. The configured AI provider brainstorms unique titles first, then writes each one in full:

```bash
# 5 fresh Flights articles, saved as drafts
node generate.js --category flights --count 5

# 10 Hotels articles, published immediately
node generate.js -c hotels -n 10 --publish

# Or, no flags at all — arrow-key menu asks you for category + count:
node generate.js
```

## Generate one specific article (you supply the title)

```bash
node generate.js "Best cheap flights from London to Bangkok in 2026"
```

Output:
```
→ Generating: "Best cheap flights from London to Bangkok in 2026" … done in 8.4s
  title: 7 Proven Hacks for Cheap London-Bangkok Flights in 2026
  slug:  cheap-flights-london-bangkok-2026
  words: 1088
  posting draft to Strapi … saved (id=42, draft)
  review: https://cms.fxnstudio.com/admin/content-manager/collection-types/api::article.article/42
```

Open the `review:` URL → Strapi draft is waiting for you.

## Generate posts for NXT.Bargains, BestLooking.Skin, and NXTSmart.Homes

Use `generate-site-post.js` for the site-specific blog collections:

```bash
# Prompt for site, category, and what to generate
node generate-site-post.js

# NXT.Bargains → /api/nxt-posts
node generate-site-post.js --site nxt.bargains --category product-comparisons --count 3

# BestLooking.Skin → /api/bls-posts
node generate-site-post.js --site bestlooking.skin "Best vitamin C serums for sensitive skin" --category skincare-reviews

# NXTSmart.Homes → /api/nxtsmart-posts
node generate-site-post.js --site nxtsmart.homes --category smart-home-security --count 5

# Publish immediately instead of creating drafts
node generate-site-post.js --site nxtsmart.homes --category smart-home-devices --count 2 --publish

# Text-only posts, no Fal.ai images
node generate-site-post.js --site nxt.bargains --category product-roundups --count 2 --no-images

# Higher-quality image model
node generate-site-post.js --site bestlooking.skin --category skincare-reviews --count 1 --image-model dev

# Preview without writing to Strapi
node generate-site-post.js --site bestlooking.skin --category how-to-guides --count 1 --dry-run
```

Supported sites:

| Site | Posts endpoint | Categories endpoint |
|---|---|---|
| `nxt.bargains` | `/api/nxt-posts` | `/api/nxt-categories` |
| `bestlooking.skin` | `/api/bls-posts` | `/api/bls-categories` |
| `nxtsmart.homes` | `/api/nxtsmart-posts` | `/api/nxtsmart-categories` |

Topic files work with either `category | topic` or `site | category | topic`:

```bash
node generate-site-post.js --site nxt.bargains --topics topics.txt
```

## With all the knobs

```bash
node generate.js \
  --topic "A weekend in Lisbon under £300" \
  --tone luxury \
  --length long \
  --destination Lisbon \
  --category "City Breaks" \
  --keywords "lisbon,weekend,cheap,europe,tapas"
```

Flags:
| Flag | Default | Values |
|---|---|---|
| `--topic` / `-t` | *(required)* | any string |
| `--tone` | `friendly` | `friendly · professional · adventurous · witty · luxury` |
| `--length` / `-l` | `medium` | `short` (~500), `medium` (~1000), `long` (~1800) words |
| `--destination` / `-d` | — | any place name |
| `--category` / `-c` | — | any category slug (e.g. `flights`, `hotels`) |
| `--count` / `-n` | — | integer — triggers AI to auto-brainstorm that many titles for `--category` |
| `--keywords` / `-k` | — | comma-separated SEO keywords |
| `--language` | `English` | any language |
| `--publish` | `false` | publish immediately (default: save as draft) |
| `--images` / `--no-images` | `true` | generate 1 cover + 2 gallery images via Fal.ai FLUX (requires `FAL_KEY`) |
| `--image-model` | `schnell` | `schnell` (fastest/cheapest), `dev` (higher quality), `pro` (best) |
| `--interactive` / `-i` | `false` | force the arrow-key menu |
| `--dry-run` | `false` | print JSON, don't hit Strapi |

## AI images per article (Fal.ai FLUX)

Every generated article automatically gets:

- **1 cover image** (16:9) → attached to `coverImage`
- **2 gallery images** (4:3) → attached to `gallery`

The AI model writes 3 tailored photographic prompts for each article (in the JSON response), then the CLI calls **Fal.ai FLUX** to generate the images, downloads them, uploads to Strapi's Media Library, and links them to the draft.

**Costs** (as of 2026):
- FLUX `schnell` (default): **~$0.003/image → ~$0.009 per article** (3 images)
- FLUX `dev`: ~$0.025/image → ~$0.075 per article
- FLUX `pro`: ~$0.05/image → ~$0.15 per article

Add `--no-images` to any command to skip image generation entirely.

```bash
# Fastest & cheapest (default)
node generate.js -c flights -n 5

# Higher-quality dev model
node generate.js -c hotels -n 3 --image-model dev

# Text-only drafts, no images
node generate.js -c destinations -n 10 --no-images
```

## Batch mode — generate 50 articles overnight

Create a text file with one topic per line (see `topics.sample.txt`) then:

```bash
node generate.js --topics my-topics.txt
```

The script generates them sequentially to respect provider rate limits and prints a summary at the end.

## AI provider and model

OpenAI is the default provider:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
OPENAI_MAX_OUTPUT_TOKENS=16000
```

To use Anthropic instead:

```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-5-20250929
CLAUDE_MAX_TOKENS=4096
```

To use OpenRouter instead:

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=~openai/gpt-latest
OPENROUTER_MAX_TOKENS=16000
OPENROUTER_SITE_URL=https://cms.fxnstudio.com
OPENROUTER_APP_NAME=FXN AI Writer CLI
```

## Automation ideas

- **GitHub Actions cron** — drop this tool into a repo, a scheduled workflow reads `topics-this-week.txt` and generates fresh drafts every Monday morning.
- **Content calendar spreadsheet** — export topics as CSV, `awk`/`cut` into `topics.txt`, batch-generate the week's pipeline.
- **On-demand from Slack** — tiny bot that calls `generate.js --topic "$MSG"` when you type `/write "..."`.

I can wire any of these — just ask.
