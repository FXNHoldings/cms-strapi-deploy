# Autopost — Syndication to Destination Blogs

Two complementary delivery paths, configured per **Blog Destination**.

## Lifecycle webhook (immediate)
When `schedule = "immediate"` and the article is published, Strapi's `article`
`afterCreate` / `afterUpdate` lifecycle fires an HTTP POST to `webhookUrl`
within milliseconds.

## Scheduled worker (hourly / daily-0900 / daily-1800)
The `autopost-worker` polls Strapi every 60s:
1. Finds articles with `publishedAt != null` and `autopostStatus ∈ {pending, none}`.
2. For each linked `BlogDestination`, checks `schedule` vs wall-clock.
3. Fires the same webhook payload as the lifecycle path, HMAC-signed if a
   `webhookSecret` is set on the destination.
4. Appends a structured entry to `article.autopostLog`.

## Webhook payload

```json
{
  "event": "article.published",
  "article": {
    "id": 42,
    "title": "7 Cheap Flight Hacks…",
    "slug": "cheap-flights-london-bangkok-2026",
    "excerpt": "Save up to 40%…",
    "content": "## 1. Book on the right day…",
    "coverImage": "https://cms.fxnstudio.com/uploads/hero_3f9d.jpg",
    "category": "Flights",
    "tags": ["asia", "cheap", "london"],
    "author": "Jane Doe",
    "destinations": ["Bangkok", "London"],
    "publishedAt": "2026-02-14T08:30:00.000Z"
  }
}
```

## Headers
| Header | Purpose |
|---|---|
| `Content-Type: application/json` | always |
| `X-FXN-Signature` | `hex(HMAC-SHA256(webhookSecret, raw-body))` — only if secret set |
| `Authorization` | verbatim copy of `authHeader` on the destination, e.g. `Bearer xxx` |

## Retry policy
Current behaviour is **fire-and-forget**. If you need retries:
- The worker re-checks pending articles on every tick, so a failed
  `daily-0900` run will try again next tick of the day (effectively every
  minute until it matches).
- For production retry with backoff, swap the `_post_to_destination` call for
  a task queued to Celery or a BullMQ service — I can add this in a later
  iteration.

## Idempotency on the receiver
Receivers should **upsert by `article.slug`** (unique) to stay idempotent:

```ts
await prisma.article.upsert({
  where: { slug: payload.article.slug },
  create: { …payload.article, sourceId: payload.article.id },
  update: { …payload.article, updatedAt: new Date() },
});
```
