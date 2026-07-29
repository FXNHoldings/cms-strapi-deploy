# Plugins

## 1. AI Writer

Generate publication-ready travel articles from a topic using **OpenRouter** (default) or **Anthropic direct**.

### Where to find it
Left sidebar → **AI Writer**.

### Providers

| Provider | Env | Notes |
| --- | --- | --- |
| **OpenRouter** (default) | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | One key for Claude, GPT, Gemini, etc. |
| **Anthropic** | `ANTHROPIC_API_KEY`, `AI_WRITER_ANTHROPIC_MODEL` | Direct Anthropic API |

Set default provider: `AI_WRITER_PROVIDER=openrouter` or `anthropic`.

### Inputs
- **AI provider** — OpenRouter or Anthropic (per-run override in admin UI)
- **Model** — e.g. `anthropic/claude-sonnet-4.6` (OpenRouter) or `claude-sonnet-4-5-20250929` (Anthropic)
- **Topic** *(required)* — e.g. *"Best cheap flights from London to Bangkok in 2026"*
- **Destination** — steers the article toward specific geography
- **Category** — e.g. Flights, Hotels, Travel Tips
- **Tone** — friendly / professional / adventurous / witty / luxury
- **Length** — short (~500) / medium (~1000) / long (~1800) words
- **Keywords** — comma-separated SEO keywords
- **Additional instructions** — optional extra guidance appended to the prompt

### Output
Creates a draft **Article** with:
- Title, slug, excerpt
- Markdown content (H2/H3 structure, CTA)
- SEO title, description, keywords
- Estimated reading time
- `source = "ai"` for audit

Review → attach cover image → link destinations → **Publish**.

### Programmatic use
Admin endpoints (require admin JWT):

```
GET /ai-writer/options
```

```
POST /ai-writer/generate
Content-Type: application/json
{
  "topic": "Cheapest flights to Tokyo in April 2026",
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4.6",
  "tone": "friendly",
  "length": "medium",
  "destination": "Tokyo",
  "category": "Flights",
  "keywords": ["cheap flights", "tokyo", "april 2026"],
  "customInstructions": "Mention budget airlines and cherry blossom season.",
  "createDraft": true
}
```

### Cost note
Billing depends on the provider and model selected. OpenRouter passes through provider pricing; a typical ~1000-word article is usually a few cents.

## 2. Bulk Import

Create many articles at once from **Markdown** or **CSV**.

### Where to find it
Left sidebar → **Bulk Import**.

### Markdown (.md)
Each file may start with YAML frontmatter:

```markdown
---
title: 7 cheap flight hacks from London to Bangkok
slug: cheap-flights-london-bangkok
excerpt: Save up to 40% with these seven proven tactics.
category: Flights
tags: [asia, cheap, hacks]
destinations: [Bangkok, London]
author: Jane Doe
seoTitle: 7 Cheap Flights London → Bangkok (2026)
seoDescription: Save up to 40%…
keywords: [cheap flights, bangkok, london]
readingTimeMinutes: 6
---

# Body in markdown…

## Section
…
```

Unknown categories, tags, destinations, and authors are auto-created.

### CSV
Required headers: `title`, `content`.
Optional: `slug, excerpt, category, tags, destinations, author, seoTitle, seoDescription, keywords, readingTimeMinutes`.

Use `|` to separate multiple values (tags, destinations, keywords).

Example CSV row:
```
"7 cheap flight hacks",cheap-flights-101,"Save up to 40%","# Body…",Flights,"asia|cheap","Bangkok|London","Jane Doe",,,"cheap flights|bangkok",6
```

### Report
After upload you'll see: **Created / Skipped / Errors** with per-row detail.
Duplicate slugs are skipped (not overwritten).
