#!/usr/bin/env node
/**
 * One-time backfill: download a logo for every commerce-merchant that doesn't
 * have one, and save it to the merchant's `logo` media field.
 * Source order per merchant: Clearbit logo API -> Google favicon.
 */
import { readFileSync } from 'node:fs';

const ENV = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || process.env[k] || '').trim();
const BASE = (get('STRAPI_URL') || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const TOKEN = get('STRAPI_API_TOKEN');
const H = { Authorization: `Bearer ${TOKEN}` };

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

async function uploadLogo(imageUrl, name) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const mime = res.headers.get('content-type') || 'image/png';
  if (!mime.startsWith('image/')) throw new Error(`not image (${mime})`);
  const ext = mime.includes('svg') ? 'svg' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
    : mime.includes('webp') ? 'webp' : mime.includes('x-icon') || mime.includes('vnd.microsoft.icon') ? 'ico' : 'png';
  const blob = new Blob([Buffer.from(await res.arrayBuffer())], { type: mime });
  const form = new FormData();
  form.append('files', blob, `merchant-logo-${name}.${ext}`);
  const up = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: H, body: form });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}`);
  const j = await up.json();
  return Array.isArray(j) ? j[0]?.id : j?.id;
}

async function logoMediaId(domain, slug) {
  for (const url of [`https://logo.clearbit.com/${domain}`, `https://www.google.com/s2/favicons?domain=${domain}&sz=128`]) {
    try { const id = await uploadLogo(url, slug); if (id) return { id, url }; } catch { /* next */ }
  }
  return null;
}

async function run() {
  const params = new URLSearchParams({ 'populate[logo]': 'true', 'pagination[pageSize]': '200',
    'fields[0]': 'name', 'fields[1]': 'slug', 'fields[2]': 'websiteUrl' });
  const res = await fetch(`${BASE}/api/commerce-merchants?${params}`, { headers: H });
  const rows = (await res.json())?.data || [];
  let done = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    const a = r.attributes || r;
    const docId = r.documentId || a.documentId;
    if (a.logo && (a.logo.data || a.logo.id || a.logo.url)) { skipped++; continue; }
    const domain = domainOf(a.websiteUrl);
    if (!domain) { console.log(`SKIP  ${a.name} (no websiteUrl)`); failed++; continue; }
    try {
      const got = await logoMediaId(domain, a.slug);
      if (!got) { console.log(`FAIL  ${a.name} (${domain}) — no logo source`); failed++; continue; }
      const put = await fetch(`${BASE}/api/commerce-merchants/${docId}`, {
        method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { logo: got.id } }),
      });
      if (!put.ok) { console.log(`FAIL  ${a.name} — update HTTP ${put.status}`); failed++; continue; }
      console.log(`OK    ${a.name} <- ${got.url} (media ${got.id})`); done++;
    } catch (e) { console.log(`FAIL  ${a.name} — ${e.message}`); failed++; }
  }
  console.log(`\nDone. updated=${done} alreadyHadLogo=${skipped} failed=${failed} total=${rows.length}`);
}
run();
