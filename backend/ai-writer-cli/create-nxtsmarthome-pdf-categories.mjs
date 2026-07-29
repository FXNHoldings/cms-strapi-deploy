import 'dotenv/config';

const U = process.env.STRAPI_URL || 'http://127.0.0.1:8888';
const T = process.env.STRAPI_API_TOKEN;
const SITE_KEY = 'nxtsmarthome';

// Explicit slugs from Category.pdf (do NOT auto-slugify — several differ, e.g.
// "Lighting" -> /smart-lighting, "Connectivity & Matter" -> /connectivity).
// The two rows marked "enter later or skip" (Smart Garden, Smart Health &
// Wearables) are intentionally omitted; pass --all to include them.
const CATS = [
  { slug: 'getting-started', name: 'Getting Started', description: 'Beginner guides, "what is a smart home," starter kits, renter/apartment setups, glossary.' },
  { slug: 'connectivity', name: 'Connectivity & Matter', description: 'Matter/Thread/Zigbee/Z-Wave explainers, compatibility guides, standards.' },
  { slug: 'hubs-voice-assistants', name: 'Hubs & Voice Assistants', description: 'Hub reviews, Alexa/Google/HomeKit/SmartThings, Home Assistant, voice displays.' },
  { slug: 'security-cameras', name: 'Security & Cameras', description: 'Cameras, video doorbells, DIY security, sensors, alarms.' },
  { slug: 'smart-locks', name: 'Smart Locks', description: 'Lock reviews, comparisons, "locks without wifi," keypad/biometric guides.' },
  { slug: 'smart-lighting', name: 'Lighting', description: 'Bulbs, light strips, switches, "do you need a hub for lights".' },
  { slug: 'energy-climate', name: 'Energy & Climate', description: 'Thermostats, smart plugs, energy monitoring, C-wire guides, savings.' },
  { slug: 'cleaning-robots', name: 'Cleaning & Robots', description: 'Robot vacuums, mops, everyday automation routines.' },
  { slug: 'entertainment', name: 'Entertainment', description: 'Smart TVs, streaming, speakers — add if you find affiliate demand.' },
  { slug: 'deals', name: 'Deals Hub', description: 'A standalone seasonal/evergreen deals landing page — high affiliate value, worth building.' },
];
const LATER = [
  { slug: 'smart-garden', name: 'Smart Garden', description: 'Competitor strength; enter later or skip.' },
  { slug: 'health-wearables', name: 'Smart Health & Wearables', description: 'Competitor strength; enter later or skip.' },
];
const LIST = process.argv.includes('--all') ? [...CATS, ...LATER] : CATS;

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

for (const { slug, name, description } of LIST) {
  const found = await api(`/api/gatsby-categories?filters[slug][$eq]=${encodeURIComponent(slug)}&pagination[pageSize]=1`);
  if (found.j?.data?.length) {
    const cat = found.j.data[0];
    const up = await api(`/api/gatsby-categories/${cat.documentId}`, { method: 'PUT', body: JSON.stringify({ data: { name, description, sites: { connect: [site.id] } } }) });
    console.log(`  = "${name}" (/${slug}) existed → updated + linked (${up.status})`);
    continue;
  }
  const c = await api('/api/gatsby-categories', { method: 'POST', body: JSON.stringify({ data: { name, slug, description, sites: [site.id] } }) });
  console.log(`  ${c.status < 300 ? '+ created' : '✗ FAILED ' + c.status}: "${name}"  (/${slug})${c.status < 300 ? '' : ' — ' + (c.t || '').slice(0, 160)}`);
}

const final = await api(`/api/gatsby-categories?filters[sites][key][$eq]=${SITE_KEY}&pagination[pageSize]=100&sort[0]=name:asc`);
console.log(`\n${SITE_KEY} categories now (${(final.j?.data || []).length}):`);
for (const d of (final.j?.data || [])) console.log(`  · ${attr(d, 'name').padEnd(26)} /${attr(d, 'slug')}`);
