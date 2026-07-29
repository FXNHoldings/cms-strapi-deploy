import 'dotenv/config';

const STRAPI_URL = process.env.STRAPI_URL || 'http://127.0.0.1:8888';
const TOKEN = process.env.STRAPI_API_TOKEN;

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

const SITES = [
  { key: 'nxtsmarthome', name: 'NXT Smart Home', domain: 'nxtsmarthome.com.au' },
  { key: 'indepthdaily', name: 'In Depth Daily', domain: 'indepthdaily.com' }
];

console.log('STRAPI_URL:', STRAPI_URL, '| token set:', Boolean(TOKEN));

// 1) probe the new type
const list = await strapi('/api/gatsby-sites?pagination[pageSize]=100');
console.log('GET /api/gatsby-sites ->', list.status, list.json ? `(count ${list.json.data?.length ?? '?'})` : list.text.slice(0, 200));

if (list.status !== 200) {
  console.log('\n⚠️  gatsby-sites not readable by this token. If 403/401 the API token needs find/create on Gatsby · Site.');
  process.exit(0);
}

// 2) upsert the two sites
const existing = new Map((list.json.data || []).map(d => [d.key ?? d.attributes?.key, d]));
for (const s of SITES) {
  if (existing.has(s.key)) { console.log(`  = exists: ${s.key}`); continue; }
  const r = await strapi('/api/gatsby-sites', { method: 'POST', body: JSON.stringify({ data: s }) });
  console.log(`  ${r.status < 300 ? '+ created' : '✗ FAILED ' + r.status}: ${s.key}`, r.status < 300 ? '' : (r.text || '').slice(0, 200));
}

// 3) show final
const final = await strapi('/api/gatsby-sites?pagination[pageSize]=100');
console.log('\nGatsby sites now:', (final.json?.data || []).map(d => (d.key ?? d.attributes?.key)));
