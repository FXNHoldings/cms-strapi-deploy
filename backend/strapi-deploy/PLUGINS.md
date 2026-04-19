# Plugins

## 1. AI Writer

Generate publication-ready travel articles from a topic using **Claude Sonnet 4.5**.

### Where to find it
Left sidebar → **AI Writer**.

### Inputs
- **Topic** *(required)* — e.g. *"Best cheap flights from London to Bangkok in 2026"*
- **Destination** — steers Claude toward specific geography
- **Category** — e.g. Flights, Hotels, Travel Tips
- **Tone** — friendly / professional / adventurous / witty / luxury
- **Length** — short (~500) / medium (~1000) / long (~1800) words
- **Keywords** — comma-separated SEO keywords

### Output
Creates a draft **Article** with:
- Title, slug, excerpt
- Markdown content (H2/H3 structure, CTA)
- SEO title, description, keywords
- Estimated reading time
- `source = "ai"` for audit

Review → attach cover image → link destinations → **Publish**.

### Programmatic use
Admin endpoint (requires admin JWT):
```
POST /ai-writer/generate
Content-Type: application/json
{
  "topic": "Cheapest flights to Tokyo in April 2026",
  "tone": "friendly",
  "length": "medium",
  "destination": "Tokyo",
  "category": "Flights",
  "keywords": ["cheap flights", "tokyo", "april 2026"],
  "createDraft": true
}
```

### Cost note
Claude Sonnet 4.5 pricing (as of 2025-09): **$3/M input, $15/M output tokens**.
A typical ~1000-word article costs ≈ $0.01–0.03.

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
