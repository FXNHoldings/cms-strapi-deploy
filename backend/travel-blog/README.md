# FXN Studio Travel Blog — Next.js 15 frontend

Editorial travel blog that consumes your Strapi CMS (`cms.fxnstudio.com`) and deploys to Vercel in ~2 minutes.

## Stack
- Next.js 15 (App Router, React Server Components)
- Tailwind CSS + `@tailwindcss/typography` for article rendering
- Fraunces serif display + Geist sans body (distinctive editorial look)
- Fetches from Strapi 5 REST API, with ISR (60 s stale-while-revalidate)
- Fully responsive, SEO-ready (Open Graph, Twitter cards, canonical URLs)

## Pages
- `/` — Home: featured article + latest by category + destinations
- `/articles` — All articles (paginated)
- `/articles/[slug]` — Article detail with related by category
- `/category/[slug]` — Category landing (e.g. Flights, Hotels, Tips)
- `/destinations` — All destinations grid
- `/destinations/[slug]` — Destination page with all articles about it

## Local development

```bash
cd backend/travel-blog
cp .env.example .env.local
# edit NEXT_PUBLIC_STRAPI_URL if your CMS is elsewhere
npm install     # or: pnpm install / yarn
npm run dev     # → http://localhost:3000
```

## Deploy to Vercel

1. Push this repo to GitHub (already done via Emergent's Save to GitHub).
2. Go to [vercel.com/new](https://vercel.com/new) → Import your repo.
3. Vercel auto-detects Next.js. In **Project Settings → Root Directory**, set:
   ```
   backend/travel-blog
   ```
4. Add environment variables:
   ```
   NEXT_PUBLIC_STRAPI_URL = https://cms.fxnstudio.com
   REVALIDATE_SECRET      = <long random string>
   ```
5. Click **Deploy**. First build takes ~90 s.

## Point your domain at Vercel

In your DNS provider (where `fxnstudio.com` is registered):

| Type  | Name | Value |
|-------|------|-------|
| A     | `@`  | `76.76.21.21` (Vercel) |
| CNAME | `www`| `cname.vercel-dns.com` |

Leave `cms.fxnstudio.com` pointing at Hetzner unchanged. In Vercel → **Settings → Domains**, add `fxnstudio.com` and `www.fxnstudio.com`.

> ⚠️ Before switching `www` DNS, update the Caddyfile on Hetzner to drop the `www` and apex rule (keep only `cms.fxnstudio.com`). Otherwise Caddy will keep trying to renew certs for domains it no longer owns.

## On-demand revalidation (optional)
When an editor publishes in Strapi, trigger a cache bust so the blog updates instantly:

1. In Strapi admin → **Settings → Webhooks → Create new webhook**:
   - URL: `https://www.fxnstudio.com/api/revalidate?secret=<REVALIDATE_SECRET>`
   - Events: `Entry: publish`, `Entry: update`, `Entry: unpublish`

Without this, the blog revalidates every 60 s anyway (plenty for a blog).

## Customising the look
- Colours: `tailwind.config.ts` (`forest`, `sand`, `terracotta`, `paper`, `ink`)
- Fonts: `app/layout.tsx` — swap Fraunces / Geist for any other pair you like
- Home hero copy: `app/page.tsx`
