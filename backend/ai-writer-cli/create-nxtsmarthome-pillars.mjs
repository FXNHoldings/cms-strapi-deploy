import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const {
  AI_PROVIDER = 'anthropic', ANTHROPIC_API_KEY, CLAUDE_MODEL = 'claude-sonnet-4-6', CLAUDE_MAX_TOKENS = '16000',
  OPENROUTER_API_KEY, OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6',
  OPENAI_API_KEY, OPENAI_MODEL = 'gpt-4o',
  STRAPI_URL = 'http://127.0.0.1:8888', STRAPI_API_TOKEN,
} = process.env;
const provider = (AI_PROVIDER || 'anthropic').toLowerCase();
const anthropic = provider === 'anthropic' ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const openrouter = provider === 'openrouter' ? new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' }) : null;
const openai = provider === 'openai' ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const SITE = 'nxtsmarthome';

const PILLARS = [
  { slug: 'smart-home-guide', title: 'Complete Smart Home Guide for Beginners', cat: 'getting-started',
    sub: ['What is a smart home', 'Do you need a hub', 'Smart home starter kits', 'Best budget devices', 'Renter & apartment setups', 'Smart home glossary'] },
  { slug: 'matter-thread-guide', title: 'Matter & Thread Explained', cat: 'connectivity-and-matter',
    sub: ['Matter vs Thread vs Zigbee vs Z-Wave', 'Best Matter-compatible devices', 'How to check Matter compatibility', 'Matter troubleshooting', 'Which hubs support Thread'] },
  { slug: 'best-smart-home-hub', title: 'Best Smart Home Hubs & Ecosystems', cat: 'hubs-and-voice-assistants',
    sub: ['Alexa vs Google vs HomeKit vs SmartThings', 'Home Assistant for beginners', 'Choosing a hub', 'Voice assistant comparison', 'Matching a hub to your devices'] },
  { slug: 'best-smart-security-camera', title: 'Home Security & Cameras', cat: 'security-and-cameras',
    sub: ['Best video doorbells', 'Indoor vs outdoor cameras', 'Best smart locks', 'DIY security without a subscription', 'Camera privacy & data'] },
  { slug: 'smart-home-energy-guide', title: 'Energy, Climate & Lighting', cat: 'energy-and-climate',
    sub: ['Best smart thermostats', 'Best smart bulbs & lighting', 'Smart plugs & energy monitoring', 'Do smart devices save energy', 'C-wire and wiring basics'] },
  { slug: 'best-robot-vacuum', title: 'Cleaning & Everyday Automation', cat: 'cleaning-and-robots',
    sub: ['Best robot vacuums by budget', 'Robot vacuums for pet hair', 'Robot vacuum vs robot mop', 'Everyday automation routines', 'Maintenance & longevity'] },
];

async function callAI(system, user) {
  if (provider === 'openai') { const r = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 16000 }); return r.choices?.[0]?.message?.content?.trim() || ''; }
  if (provider === 'openrouter') { const r = await openrouter.chat.completions.create({ model: OPENROUTER_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 16000 }); return r.choices?.[0]?.message?.content?.trim() || ''; }
  const m = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: Math.max(parseInt(CLAUDE_MAX_TOKENS, 10) || 0, 16000), system, messages: [{ role: 'user', content: user }] });
  return m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { const m = s.match(/\{[\s\S]*\}/); return m ? (() => { try { return JSON.parse(m[0]); } catch { return null; } })() : null; }; };

const SYSTEM = `You are a senior smart-home editor writing an evergreen PILLAR / HUB page for an affiliate review site (nxtsmarthome.com.au). Audience: DIY enthusiasts, tech-savvy homeowners and modern families across the US, UK and Australia.

Output STRICT JSON only (no markdown fences, no text outside it):
{ "excerpt": string, "seoTitle": string, "seoDescription": string, "seoKeywords": string, "content": string }

content = Markdown body, 900-1400 words:
- Open with a 2-3 sentence intro stating exactly what this hub covers and who it's for.
- One H2 (##) section per provided sub-topic, in order, each genuinely informative.
- Where a buying decision belongs, insert this exact placeholder on its own line: > **[Comparison table + top pick — add real evaluated products, prices and affiliate links here]**
- Close with a short "Where to start" section pointing readers to the most relevant next guide.

Hard rules:
- Do NOT invent specific prices, model numbers, spec figures, or test results. Keep product references general and truthful; the real picks are added later by a human with live data.
- Factual, plain, helpful. No fabricated first-hand testing claims.
- Banned words/phrases: nestled, game-changer, cutting-edge, seamless, elevate, unlock, in today's world, look no further, dive in, delve, tapestry, must-have, world-class.`;

async function strapi(path, init = {}) {
  const r = await fetch(`${STRAPI_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STRAPI_API_TOKEN}`, ...(init.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, j, t };
}
const attr = (r, k) => r?.[k] ?? r?.attributes?.[k];

const site = (await strapi(`/api/gatsby-sites?filters[key][$eq]=${SITE}`)).j?.data?.[0];
if (!site) { console.error('nxtsmarthome gatsby-site not found'); process.exit(1); }
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

const only = process.argv[2];
const LIST = only ? PILLARS.filter((p) => p.slug === only) : PILLARS;
for (const p of LIST) {
  process.stdout.write(`▸ ${p.title}  (/${p.slug}) … `);
  const catRes = await strapi(`/api/gatsby-categories?filters[slug][$eq]=${p.cat}&pagination[pageSize]=1`);
  const catId = catRes.j?.data?.[0]?.id;
  const user = `Pillar title: ${p.title}\nSub-topics to cover as H2 sections (in this order):\n- ${p.sub.join('\n- ')}`;
  let art;
  try { art = safeParse(await callAI(SYSTEM, user)); } catch (e) { console.log('AI error: ' + e.message); continue; }
  if (!art?.content) { console.log('no content returned'); continue; }
  // upsert by slug
  const existing = (await strapi(`/api/gatsby-posts?filters[slug][$eq]=${p.slug}&pagination[pageSize]=1`)).j?.data?.[0];
  const data = {
    title: p.title, slug: p.slug, excerpt: trunc(art.excerpt || '', 480), content: art.content,
    postType: 'guide', readingTimeMinutes: Math.max(5, Math.round((art.content.split(/\s+/).length) / 200)),
    seoTitle: trunc(art.seoTitle || p.title, 68), seoDescription: trunc(art.seoDescription || '', 158),
    seoKeywords: art.seoKeywords || '', source: 'ai', sites: [site.id], publishedAt: new Date().toISOString(),
  };
  if (catId) data.categories = [catId];
  const res = existing
    ? await strapi(`/api/gatsby-posts/${existing.documentId}`, { method: 'PUT', body: JSON.stringify({ data }) })
    : await strapi('/api/gatsby-posts', { method: 'POST', body: JSON.stringify({ data }) });
  console.log(res.status < 300 ? `${existing ? 'updated' : 'created'} #${res.j?.data?.id} (${data.content.split(/\s+/).length} words)` : `FAILED ${res.status} ${(res.t || '').slice(0, 140)}`);
}
console.log('\nDone. Rebuild: /opt/gatsby/scripts/rebuild-site.sh nxtsmarthome');
