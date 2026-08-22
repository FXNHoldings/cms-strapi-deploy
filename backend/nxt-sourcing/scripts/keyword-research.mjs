/**
 * Keyword research: real search volume, plus judgement about it.
 *
 *   node scripts/keyword-research.mjs --seed="smart doorbell"
 *   node scripts/keyword-research.mjs --seed="robot vacuum" --count=25 --longtail
 *   node scripts/keyword-research.mjs --seed="smart lock" --site=nxtsmart.homes
 *   node scripts/keyword-research.mjs --seed="smart plug" --queue-to=<populator-id>
 *
 * The split matters more than the feature. Search volume, competition and CPC
 * are FACTS, and DataForSEO sells them for about a cent and a half a search.
 * Relevance to a particular site, and what to write, are JUDGEMENTS, and a
 * model is the right tool for those.
 *
 * The obvious shortcut is to ask a model for all five and print the result.
 * That produces a number like "1,200 visitors/month" with nothing behind it —
 * confident, specific, and invented. Those numbers would then decide what gets
 * written, so the cost of being wrong is a content plan aimed at traffic that
 * does not exist. Measured where measurable; inferred only where it must be.
 *
 * Volume is Australian by default (location_code 2036). The same script family
 * defaults to 2840 (United States) elsewhere, which is how the offer repair
 * ended up returning US sellers for an AU catalogue — an easy mistake, made
 * once already, so the default here matches the sites.
 */

import { anthropicConfigured, anthropicModel, askForJson } from './lib/anthropic-chat.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const SEED = flag('seed', null);
const COUNT = Math.min(200, Math.max(1, Number(flag('count', 20))));
const LONGTAIL = args.includes('--longtail');
const SITE = flag('site', null);
const EXTRA = flag('instructions', '');
const QUEUE_TO = flag('queue-to', null);
const LOCATION = Number(flag('location', 2036));
const LANGUAGE = flag('language', 'en');
const JSON_OUT = args.includes('--json');

const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const IDEAS_EP = 'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live';

const AI_MODEL = anthropicModel('KEYWORD_RESEARCH_MODEL');

const STRAPI_URL = (process.env.STRAPI_INTERNAL_URL || process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';

if (!SEED) {
  console.error('Usage: --seed="<keyword>" [--count=20] [--longtail] [--site=<domain>] [--queue-to=<populatorDocumentId>]');
  process.exit(2);
}

/* The password may already be a base64 login:password blob. Same handling as
   every other DataForSEO script here, so one credential format works throughout. */
function authHeader() {
  try {
    const [l, ...rest] = Buffer.from(DFS_PASSWORD, 'base64').toString('utf8').split(':');
    if (rest.length && l.includes('@')) return `Basic ${DFS_PASSWORD}`;
  } catch { /* not base64 */ }
  return `Basic ${Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64')}`;
}

async function strapi(pathname, init = {}) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    ...init,
    headers: {
      ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** MEASURED: volume, competition and CPC as reported by Google Ads data. */
async function fetchIdeas() {
  const res = await fetch(IDEAS_EP, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      keywords: [SEED],
      location_code: LOCATION,
      language_code: LANGUAGE,
      // Ask for more than requested so the longtail filter has something to cut.
      limit: Math.min(300, COUNT * (LONGTAIL ? 6 : 3)),
      order_by: ['keyword_info.search_volume,desc'],
    }]),
    signal: AbortSignal.timeout(60000),
  });

  const json = await res.json();
  const task = json?.tasks?.[0];
  if (task?.status_code !== 20000) throw new Error(`DataForSEO ${task?.status_code}: ${task?.status_message}`);

  const items = (task?.result?.[0]?.items ?? []).map((it) => ({
    keyword: it.keyword,
    volume: it.keyword_info?.search_volume ?? null,
    competition: it.keyword_info?.competition ?? null,
    cpc: it.keyword_info?.cpc ?? null,
    words: String(it.keyword ?? '').trim().split(/\s+/).length,
  })).filter((k) => k.keyword && k.volume != null);

  const filtered = LONGTAIL ? items.filter((k) => k.words >= 3) : items;
  return { cost: json.cost ?? 0, keywords: filtered.slice(0, COUNT) };
}

/** INFERRED: relevance to this site, and what to do with each keyword. */
const ENRICH_SCHEMA = {
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          relevance: { type: 'integer', description: '0-100, how well it fits this site specifically' },
          intent: { type: 'string', description: 'what the searcher actually wants, under 12 words' },
          suggestion: { type: 'string', description: 'what to publish for it, under 20 words' },
        },
        required: ['keyword', 'relevance', 'intent', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['keywords'],
  additionalProperties: false,
};

async function enrich(keywords) {
  if (!anthropicConfigured()) return { error: 'no ANTHROPIC_API_KEY set' };

  const prompt = [
    SITE ? `The site is ${SITE}.` : 'The site is a consumer product review and comparison publication.',
    EXTRA ? `Additional context: ${EXTRA}` : '',
    '',
    'For each keyword below, judge its relevance to this site, the intent behind',
    'it, and what to publish for it.',
    '',
    'Do NOT estimate search volume, competition or cost per click. Those are',
    'measured and already known; inventing them would corrupt the data.',
    '',
    'Return one entry per keyword, using the keyword exactly as given.',
    '',
    keywords.map((k) => `- ${k.keyword}`).join('\n'),
  ].join('\n');

  /* Report which of these went wrong. An earlier version returned null for a
     missing key, a refused request and unparseable output alike, and printed
     "no OPENROUTER_API_KEY" for all three — so an out-of-credit account looked
     like a configuration mistake. askForJson now raises the real reason. */
  try {
    const { keywords: rows } = await askForJson({
      prompt,
      schema: ENRICH_SCHEMA,
      model: AI_MODEL,
    });
    return { map: new Map(rows.map((r) => [String(r.keyword ?? '').toLowerCase(), r])) };
  } catch (error) {
    return { error: error.message };
  }
}

async function main() {
  const { cost, keywords } = await fetchIdeas();
  if (!keywords.length) {
    console.error(`No keywords returned for "${SEED}". Try a broader seed.`);
    process.exit(1);
  }

  const enriched = await enrich(keywords);
  const judged = enriched?.map ?? null;
  const rows = keywords.map((k) => {
    const j = judged?.get(k.keyword.toLowerCase());
    return { ...k, relevance: j?.relevance ?? null, intent: j?.intent ?? null, suggestion: j?.suggestion ?? null };
  });

  // Best first: relevance decides order when known, volume when it is not.
  rows.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || (b.volume ?? 0) - (a.volume ?? 0));

  if (JSON_OUT) {
    console.log(JSON.stringify({ seed: SEED, location: LOCATION, cost, keywords: rows }, null, 2));
  } else {
    console.log(`"${SEED}" · ${rows.length} keyword(s) · location ${LOCATION} · DataForSEO cost $${cost.toFixed(4)}`);
    console.log(judged ? '' : `(relevance and suggestions unavailable — ${enriched?.error ?? 'unknown reason'}. Volume below is still measured.)\n`);
    for (const r of rows) {
      const rel = r.relevance == null ? '   ' : String(r.relevance).padStart(3);
      console.log(`  ${String(r.volume).padStart(6)}/mo  comp ${String(r.competition ?? '-').padStart(4)}  rel ${rel}  ${r.keyword}`);
      if (r.suggestion) console.log(`          ${r.suggestion}`);
    }
  }

  if (QUEUE_TO) {
    const existing = await strapi(`/api/content-populators/${QUEUE_TO}`);
    const queue = Array.isArray(existing?.data?.topicQueue) ? existing.data.topicQueue : [];
    const additions = rows.filter((r) => (r.relevance ?? 100) >= 60).map((r) => r.suggestion || r.keyword);
    await strapi(`/api/content-populators/${QUEUE_TO}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { topicQueue: [...queue, ...additions] } }),
    });
    console.log(`\nqueued ${additions.length} topic(s) onto populator ${QUEUE_TO} (${queue.length} were already waiting)`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
