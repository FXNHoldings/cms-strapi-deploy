# Deployment Guide — Hetzner CX22 + Docker

Target: fresh **Hetzner Cloud** CX22 VPS (Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, 40 GB disk), domain `fxnstudio.com` with DNS pointed to the server.

---

## 1. Provision the server on Hetzner

1. Log into [console.hetzner.cloud](https://console.hetzner.cloud).
2. **Add Server**
   - Location: any (Falkenstein / Nuremberg / Helsinki — pick the closest to your audience).
   - Image: **Ubuntu 24.04**.
   - Type: **CX22** (shared vCPU, 4 GB RAM, 40 GB NVMe) — €4.51/mo.
   - Networking: enable IPv4.
   - SSH Key: add your public key (paste `~/.ssh/id_ed25519.pub`).
   - Name: `fxn-cms-01`.
3. **Create & Buy Now**. Note the server's IPv4 address.

## 2. DNS — point domain to the server

In your DNS provider (where `fxnstudio.com` is registered):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A    | `cms` | `<server-ipv4>` | 300 |
| A    | `www` | `<server-ipv4>` | 300 |
| A    | `@`   | `<server-ipv4>` | 300 |

Wait ~5 min, then verify:

```bash
dig +short cms.fxnstudio.com
dig +short www.fxnstudio.com
```

Both should return your server's IP.

## 3. Bootstrap the server

```bash
ssh root@<server-ipv4>
# Copy the setup script (or clone your repo and run it from there):
curl -fsSL -o setup.sh \
  https://raw.githubusercontent.com/<your-repo>/main/scripts/setup-hetzner.sh
bash setup.sh
```

This installs Docker + Compose, creates a `deploy` user, configures UFW
(ports 22/80/443), disables root/password SSH, and enables unattended security
upgrades. Log out and back in as `deploy`:

```bash
ssh deploy@<server-ipv4>
```

## 4. Clone & configure the stack

```bash
git clone <your-git-repo> ~/fxn-cms
cd ~/fxn-cms

# Generate strong secrets
./scripts/generate-secrets.sh > .secrets.env

# Create your real .env from the template + generated secrets
cp .env.example .env
cat .secrets.env >> .env
rm .secrets.env

# Edit .env and fill in:
#   ANTHROPIC_API_KEY           (https://console.anthropic.com/settings/keys)
#   AUTOPOST_STRAPI_TOKEN       (leave blank for now — you'll set this in step 7)
nano .env
```

## 5. First boot

```bash
docker compose up -d --build postgres strapi caddy
docker compose logs -f strapi
```

Wait for the line `Welcome to Strapi`. Then open:

👉 **https://cms.fxnstudio.com/admin**

Caddy obtains a Let's Encrypt cert automatically on first hit.

Create the **first admin user** (this is Strapi's super-admin).

## 6. Expose the REST API (public read)

In Strapi admin:

- **Settings → Users & Permissions → Roles → Public**
- Check `find` and `findOne` on: `Article`, `Category`, `Destination`, `Tag`,
  `Author`. Leave `Blog-destination` unchecked (private).
- Save.

Verify from your laptop:

```bash
curl https://cms.fxnstudio.com/api/articles | jq
```

## 7. Create the autopost API token

- **Settings → API Tokens → Create new API Token**
  - Name: `autopost-worker`
  - Token type: **Full access**
  - Duration: **Unlimited**
- Copy the token value (shown once).
- On server:

```bash
nano .env
# set AUTOPOST_STRAPI_TOKEN=<paste token>

docker compose up -d autopost-worker
docker compose logs -f autopost-worker
# Should print:  scheduler started — interval=60s
```

Sanity-check the worker:

```bash
curl -s http://127.0.0.1 -H 'Host: cms.fxnstudio.com' \
     -X POST https://cms.fxnstudio.com/autopost/trigger
# or internally:
docker compose exec autopost-worker curl -s -X POST http://localhost:8001/trigger
```

## 8. First article via AI

- **AI Writer** in the left nav → type a topic, click **Generate article**
  → a draft Article is created (Source = `ai`).
- Attach a cover image, pick destinations/tags, set category, **Publish**.

## 9. Register your first Blog Destination

- **Content Manager → Blog Destination → Create**
  - Name: `fxn-main-blog`
  - Base URL: `https://www.fxnstudio.com`
  - Webhook URL: the endpoint on the receiving blog (e.g. `https://www.fxnstudio.com/api/receive`)
  - Webhook secret: a long random string (keep a copy — you'll verify HMAC on the receiver)
  - Schedule: `immediate` | `hourly` | `daily-0900` | `daily-1800` | `manual`
  - Auto post on publish: ✅
- Link this destination to an Article and publish — observe the `autopostLog`
  field on the Article afterwards.

## 10. Nightly backups

```bash
crontab -e
# add:
0 3 * * * cd /home/deploy/fxn-cms && ./scripts/backup.sh >> /var/log/fxn-backup.log 2>&1
```

Backups go to `./backups/` and are pruned after 14 days. Optionally rsync them
off-server to Cloudflare R2, S3, or Hetzner Storage Box.

## 11. Upgrades

```bash
cd ~/fxn-cms
git pull
docker compose pull
docker compose up -d --build
```

To upgrade Strapi itself (major):

```bash
docker compose exec strapi npx @strapi/upgrade latest
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| TLS cert fails | DNS not pointing yet — wait, then `docker compose restart caddy` |
| Admin build OOM | CX22 has 4 GB; should be fine. If it fails: `docker compose build strapi --no-cache` with swap enabled |
| `ECONNREFUSED 5432` | Postgres health check still pending — `docker compose logs postgres` |
| Autopost not firing | Check `docker compose logs autopost-worker` — most likely missing/invalid `AUTOPOST_STRAPI_TOKEN` |
| Webhook receiver returns 401 | Validate HMAC: `HMAC-SHA256(webhookSecret, raw-body) == header X-FXN-Signature` |

## Receiving-side verification example (Node.js)

```js
import crypto from 'crypto';

app.post('/api/receive', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.header('x-fxn-signature');
  const expected = crypto
    .createHmac('sha256', process.env.FXN_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');
  if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).end();
  }
  const { event, article } = JSON.parse(req.body.toString());
  // … upsert article into your destination blog …
  res.status(200).end();
});
```

---

Once `cms.fxnstudio.com` is live and you've published a couple of articles,
let me know and we'll build the **Next.js travel blog frontend** that consumes
the Strapi API and deploys to Vercel.
