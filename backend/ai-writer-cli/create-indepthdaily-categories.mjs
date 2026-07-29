import 'dotenv/config';
import slugify from 'slugify';

const U = process.env.STRAPI_URL || 'http://127.0.0.1:8888';
const T = process.env.STRAPI_API_TOKEN;
const SITE_KEY = process.argv[2] || 'indepthdaily';
const NAMES = process.argv.slice(3).length ? process.argv.slice(3) : ['Technology', 'Travel', 'Entertainment', 'Health'];

async function api(path, init = {}) {
  const r = await fetch(`${U}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}`, ...(init.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, j, t };
}
const attr = (row, k) => row?.[k] ?? row?.attributes?.[k];

// wait for Strapi + the category.sites field
let ready = false;
for (let i = 0; i < 12; i++) {
  const r = await api('/api/gatsby-categories?populate=sites&pagination[pageSize]=1');
  if (r.status === 200) { ready = true; break; }
  await new Promise((res) => setTimeout(res, 4000));
}
if (!ready) { console.error('Strapi not ready (category populate=sites failed)'); process.exit(1); }

// resolve site id
const sitesRes = await api('/api/gatsby-sites?pagination[pageSize]=100');
const site = (sitesRes.j?.data || []).find((d) => attr(d, 'key') === SITE_KEY);
if (!site) { console.error(`site "${SITE_KEY}" not found`); process.exit(1); }
console.log(`Site: ${attr(site, 'name')} (id ${site.id}, doc ${site.documentId})`);

for (const name of NAMES) {
  const slug = slugify(name, { lower: true, strict: true });
  const found = await api(`/api/gatsby-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1&populate=sites`);
  if (found.j?.data?.length) {
    const cat = found.j.data[0];
    const linked = (attr(cat, 'sites') || cat.sites || []).some?.((s) => (s.key ?? s.attributes?.key) === SITE_KEY);
    if (!linked && cat.documentId) {
      const up = await api(`/api/gatsby-categories/${cat.documentId}`, { method: 'PUT', body: JSON.stringify({ data: { sites: { connect: [site.id] } } }) });
      console.log(`  = "${name}" exists → linked to ${SITE_KEY} (${up.status})`);
    } else console.log(`  = "${name}" exists (already linked)`);
    continue;
  }
  const c = await api('/api/gatsby-categories', { method: 'POST', body: JSON.stringify({ data: { name, slug, sites: [site.id] } }) });
  console.log(`  ${c.status < 300 ? '+ created' : '✗ FAILED ' + c.status}: "${name}"${c.status < 300 ? '' : ' — ' + (c.t || '').slice(0, 200)}`);
}

// show final list for the site
const final = await api(`/api/gatsby-categories?filters[sites][key][$eq]=${SITE_KEY}&pagination[pageSize]=100&sort[0]=name:asc`);
console.log(`\n${SITE_KEY} categories:`, (final.j?.data || []).map((d) => attr(d, 'name')));
