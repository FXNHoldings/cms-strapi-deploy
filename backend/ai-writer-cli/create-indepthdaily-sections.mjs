import 'dotenv/config';
import slugify from 'slugify';

const U = process.env.STRAPI_URL || 'http://127.0.0.1:8888';
const T = process.env.STRAPI_API_TOKEN;
const SITE_KEY = 'indepthdaily';

const CATS = [
  { name: 'General & Breaking News', description: 'Urgent, top-of-the-hour local and global events.' },
  { name: 'Politics', description: 'Government actions, elections, and public policy.' },
  { name: 'Business & Finance', description: 'Markets, economy, personal finance, and corporate updates.' },
  { name: 'Sports', description: 'Professional and amateur athletic competitions and scores.' },
  { name: 'Property & Real Estate', description: 'Housing markets, building, and development.' },
  { name: 'Lifestyle & Health', description: 'Wellness, fitness, medical research, and food.' },
  { name: 'Entertainment & Culture', description: 'Movies, TV, music, and celebrity updates.' },
  { name: 'Science & Technology', description: 'Innovations, environment, gadgets, and research.' },
  { name: 'Travel', description: 'Travel tips, latest information.' },
];

async function api(path, init = {}) {
  const r = await fetch(`${U}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}`, ...(init.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, j, t };
}
const attr = (row, k) => row?.[k] ?? row?.attributes?.[k];

const sitesRes = await api('/api/gatsby-sites?pagination[pageSize]=100');
const site = (sitesRes.j?.data || []).find((d) => attr(d, 'key') === SITE_KEY);
if (!site) { console.error(`site "${SITE_KEY}" not found`); process.exit(1); }
console.log(`Site: ${attr(site, 'name')} (id ${site.id})\n`);

for (const { name, description } of CATS) {
  const slug = slugify(name, { lower: true, strict: true });
  const found = await api(`/api/gatsby-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1&populate=sites`);
  if (found.j?.data?.length) {
    const cat = found.j.data[0];
    const existingDesc = attr(cat, 'description');
    const body = { data: { sites: { connect: [site.id] } } };
    if (!existingDesc) body.data.description = description;
    const up = await api(`/api/gatsby-categories/${cat.documentId}`, { method: 'PUT', body: JSON.stringify(body) });
    console.log(`  = "${name}" existed → linked to ${SITE_KEY} (${up.status})`);
    continue;
  }
  const c = await api('/api/gatsby-categories', { method: 'POST', body: JSON.stringify({ data: { name, slug, description, sites: [site.id] } }) });
  console.log(`  ${c.status < 300 ? '+ created' : '✗ FAILED ' + c.status}: "${name}"  (/${slug})${c.status < 300 ? '' : ' — ' + (c.t || '').slice(0, 160)}`);
}

const final = await api(`/api/gatsby-categories?filters[sites][key][$eq]=${SITE_KEY}&pagination[pageSize]=100&sort[0]=name:asc`);
console.log(`\n${SITE_KEY} categories (${(final.j?.data || []).length}):`);
for (const d of (final.j?.data || [])) console.log(`  · ${attr(d, 'name')}  (/${attr(d, 'slug')})`);
