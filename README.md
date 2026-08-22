# fxn-cms

Strapi 5 backend behind the FXN network of affiliate and content sites, plus the
sourcing and generation tooling that feeds it.

One CMS serves every property. Content types are namespaced per site
(`nxt-post`, `bls-post`, `nxtsmarthome-post`, …) rather than split across
instances, and the `commerce-site` collection is the registry that ties them
together — see [Site registry](#site-registry).

## Layout

| Path | What it is |
|---|---|
| `backend/strapi-deploy/` | The CMS. Docker Compose (Strapi + Postgres), 38 content types, 6 custom plugins. |
| `backend/nxt-sourcing/` | Next.js product-sourcing UI on `:3005`, plus 36 CLI scripts that do the actual catalogue work. |
| `backend/ai-writer-cli/` | Standalone generators and enrichers for fxnseo.com, run from cron and by hand. |
| `backend/scripts/` | One-off migration helpers (WordPress → Strapi). |
| `frontend/` | Legacy CRA app. Not the live frontends — those are separate repos deployed to `/opt/projects/*`. |

The job runner that executes sourcing jobs from the Strapi admin lives **outside
this repo** at `/opt/nxt-job-runner` (its own private repo). It holds only a
`RUNNER_TOKEN`; every API credential stays in `nxt-sourcing/.env.local`.

## Running the CMS

```sh
cd backend/strapi-deploy
docker compose up -d            # start
docker compose up -d --build    # after any code change (see below)
docker compose logs -f strapi
```

Strapi listens on `127.0.0.1:8888`, proxied to `cms.fxnstudio.com`.

> **The image is baked, not mounted.** Source is copied in at build time, so
> editing `strapi/src/**` changes nothing until you rebuild. A `restart` is not
> enough and neither is `up -d` on its own — you need `--build`. This is the
> single most common way to spend an hour confused: the logs will happily show
> the *old* code booting while your edit sits on disk.

### Environment

Four `.env` files, and which one applies is not obvious:

| File | Read by | Notes |
|---|---|---|
| `backend/strapi-deploy/.env` | **Docker Compose** → the container | The one that matters. Compose interpolates `${VAR}` from here. |
| `backend/strapi-deploy/strapi/.env` | Nothing, under Docker | Only used for a non-containerised local run. Holds a placeholder key; ignore it. |
| `backend/nxt-sourcing/.env.local` | The 36 CLI scripts + the `:3005` UI | All merchant/API credentials live here. |
| `backend/ai-writer-cli/.env` | The fxnseo generators | Separate again. |

`.env` is gitignored everywhere. After editing `strapi-deploy/.env`, run
`docker compose up -d` — `restart` will not re-read it.

## Plugins

Six custom admin plugins under `strapi/src/plugins/`:

- **site-dashboard** — the entry point. Grid of every property with live content
  counts, click stats, offer health, and populator state; drill into one site for
  detail. Read-only by design.
- **ai-writer** — draft an article with Claude, review, publish.
- **content-jobs** — dispatch sourcing/generation jobs to the job runner.
- **commerce-product-finder** — find and attach catalogue products.
- **bulk-import** / **article-preview** — CSV import; draft preview links.

## Site registry

`commerce-site` maps each property to the collections that belong to it, keyed by
role, each role an array because a role can have more than one source:

```jsonc
"contentTypes": {
  "posts": [
    { "uid": "api::nxtsmarthome-post.nxtsmarthome-post" },
    { "uid": "api::nxtsmart-post.nxtsmart-post",
      "filter": { "site": "nxtsmarthome.com.au" } }   // ← load-bearing
  ]
}
```

**The `filter` is not optional.** `nxtsmart.homes` and `nxtsmarthome.com.au`
share `nxtsmart-post`, split by that type's own `site` enum. Drop the filter and
each site reports the other's rows as its own, and the admin links open a list
mixing both — inviting an edit to the wrong site's post.

Seed or re-seed with `node scripts/seed-commerce-sites.mjs` (idempotent by
domain; `--dry-run` first).

## AI

**Anthropic API direct.** Everything routed through OpenRouter until August 2026,
pinned the whole time to an Anthropic model — so the gateway added a markup and a
second prepaid balance to run dry, which it did (HTTP 402, silently breaking every
`cost: 'ai'` job).

The shared client is `backend/nxt-sourcing/scripts/lib/anthropic-chat.mjs`. Use it
rather than hand-rolling a call.

```js
import { askForJson } from './lib/anthropic-chat.mjs';

const { title } = await askForJson({
  system: 'You rewrite ecommerce product titles.',
  prompt,
  schema: { type: 'object', properties: { title: { type: 'string' } },
            required: ['title'], additionalProperties: false },
});
```

Three things worth knowing:

- **No `temperature`.** Current models reject it with a 400 — not a silent
  ignore. Steer with wording. The OpenAI fallback path still accepts it.
- **JSON comes from `output_config.format`**, not from regex-extracting a `{...}`
  out of prose. Give it a schema and the shape is guaranteed.
- Default model `claude-opus-5`; override per script via
  `KEYWORD_RESEARCH_MODEL` / `PRODUCT_TITLE_REWRITE_MODEL` /
  `PRODUCT_DESCRIPTION_REWRITE_MODEL`, or globally with `ANTHROPIC_MODEL`.

The rewrite scripts keep OpenClaw (local, free) and OpenAI as fallbacks; select
with `PRODUCT_TITLE_REWRITE_PROVIDER=openclaw|anthropic|openai`.

## Sourcing scripts

36 scripts in `backend/nxt-sourcing/scripts/`. Most are also registered as jobs in
the runner, so they can be triggered from the Strapi admin — `keyword-research`,
`check-offers`, `rewrite-title`, `fetch-offers`, `post-*`, and others.

```sh
cd backend/nxt-sourcing
node scripts/keyword-research.mjs --seed="smart doorbell" --site=nxtsmart.homes
node scripts/check-offer-liveness.mjs --dry-run
```

Conventions worth matching when adding one: `--dry-run` before anything that
writes, report what will change before changing it, and exit non-zero when a run
that should have done work did nothing — a job that fails silently looks
identical to a quiet day.

> **Search volume is Australian by default** (`location_code` 2036). Other
> scripts in the same family default to 2840 (US), which is how an offer repair
> once returned US sellers for an AU catalogue.

## Scheduled work

`crontab -l` on the host. Content-related entries:

- `sync-fxnseo-cron.sh` — every 15 min, publishes Strapi `fxnseo-post` entries to
  the live fxnseo.com blog. Idempotent; a publisher, not a generator.
- `tick-populators.mjs` — **currently paused.** Reads enabled `content-populator`
  rows and dispatches their generator jobs. This is the only scheduled thing that
  *creates* content.

Price, coupon, and stock refreshes run through cronmanager (`cron-wrapper.sh <id>`).

## Deploying a change

```sh
git checkout -b feat/<thing>
# … edit …
cd backend/strapi-deploy && docker compose up -d --build
docker compose logs strapi | tail -30        # confirm the plugins bootstrap
```

Then open a PR. `main` is protected — never push to it directly.
