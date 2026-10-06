// Content rules for articles the ai-writer-cli generates for nxtsmarthome.com.au.
//
// They come from the site's own rules (projects/nxtsmarthome.com.au/CLAUDE.md)
// and the 6 October 2026 SEO audit
// (projects/nxtsmarthome.com.au/reports/nxtsmarthome.com.au-audit/):
//   S1     in-body links used the category key (/security/...) and 308-redirected;
//          18 articles had no contextual inbound links
//   S4/S5  titles over 60 characters, descriptions over 160
//   GEO-4  answers arriving after the intro; statement H2s instead of questions
//   C7     the 24 Sep - 5 Oct batch averaged 30-word sentences, no short answer
//   GEO-1  legal and safety claims with no source; C6 "or checked by an
//          electrician" contradicting /about
//   GEO-6  comparison and buying guides without a comparison table
//   C3     near-duplicate articles splitting one search intent
//   C10    guides labelled "reviews" on a site that has published none
//
// generate-site-post.js uses this module when site.contentRules is
// 'nxtsmarthome': the rules go into the prompt, research comes from web
// search (researchJson), internal links are rewritten to canonical URLs, and
// checkNxtsmarthomeContent() decides whether the article may be published.
// An article with problems is still saved, as a draft, with the problems
// printed for the editor.

export const TITLE_MAX = 60; // seoTitle; the H1 (title) may run longer
export const META_DESCRIPTION_MIN = 120;
export const META_DESCRIPTION_MAX = 155;
export const SHORT_ANSWER_WORDS = [40, 60];
export const SENTENCE_MAX = 30;
export const INTERNAL_LINKS_MIN = 2;

export const SITE_ORIGIN = 'https://nxtsmarthome.com.au';

// Strapi category slug (the site's category key) -> URL slug. lib/site.ts.
export const CATEGORY_URL_SLUG = {
  security: 'security-and-cameras',
  'smart-door-locks': 'smart-door-locks',
  lighting: 'lighting',
  energy: 'energy-and-solar',
  entertainment: 'entertainment-and-audio',
  climate: 'climate-and-comfort',
  'hubs-and-platforms': 'hubs-and-platforms',
  'robot-vacuums': 'robot-vacuums',
  'setup-guides': 'setup-guides',
  'buying-guides': 'buying-guides',
};

export const HYPE_PHRASES = [
  'elevate', 'peace of mind', 'game-changer', 'game changer', 'revolutionise', 'revolutionary',
  'seamless', 'seamlessly', 'cutting-edge', 'next level', 'next-level', 'look no further', 'in conclusion',
  'in today\'s', 'whether you\'re a', 'dive into', 'delve', 'tapestry', 'supercharge', 'effortless',
];

// Lowercase only: capitalised "Color" is Philips Hue product naming (White and Color Ambiance).
const US_SPELLING = /\b(color|colors|colored|optimize[sd]?|optimizing|center|centers|analyze[sd]?|favorite|behavior|gray|aluminum|organize[sd]?|customize[sd]?|meters? (?:away|long|wide|high))\b/;
const TESTING = /\b(?:we|I) (?:tested|have tested|trialled)\b|\bwe (?:found|noticed|loved|liked|measured)\b|\bin (?:our|my) (?:testing|tests|experience|hands-on)\b|\bhands-on (?:test|review|testing)\b|\bour (?:testing|lab|review unit)\b/i;
// "1/10 HP" is a motor rating, not a score.
const RATING = /\b\d(?:\.\d)?\s?(?:\/\s?(?:5|10)\b(?!\s?(?:HP|hp|A|W|V|mm|cm))|out of (?:5|10)\b|stars?\b)|★/i;
const OR_CHECKED = /\b(?:done|carried out|installed),? or (?:at least )?checked,? by an? (?:licensed )?electrician/i;
const LAW_AS_SETTLED = /\b(?:it is|it's) (?:illegal|legal|against the law)\b|\bthe law (?:says|requires|states)\b|\byou (?:are|'re) (?:legally|not legally) (?:required|allowed)\b/i;
const LEGAL_TOPIC = /\b(?:licensed electrician|fixed wiring|hard-?wir(?:e|ed|ing)|switchboard|AS\/NZS|surveillance|privacy act|recording audio|landlord|tenan(?:t|cy)|strata|lease)\b/i;
const OFFICIAL_SOURCE = /https?:\/\/[^\s)]*(?:\.gov\.au|esv\.vic\.gov\.au|oaic\.gov\.au|fairtrading\.nsw\.gov\.au|worksafe|electricalsafety|standards\.org\.au|accc\.gov\.au|energy\.gov\.au|esafety\.gov\.au)/i;
// A retailer price claim ("$99 at JB Hi-Fi"); a general figure ("a $20 smart plug") is fine.
const PRICE = /(?:A?\$|AUD\s?)\s?\d[\d,]*(?:\.\d\d)?\s+(?:at|from)\s+(?:[A-Z][\w&-]*)/;
const TITLE_BANNED = /!!|\b(?:tested|hands-on|honest|ultimate|best ever|verified|review(?:ed|s)?)\b/i;
const EDITORIAL_MARKERS = /\[VERIFY|\bTODO\b|\bTBD\b|\blorem\b/i;

export const NXTSMARTHOME_RULES = `# NXT Smart Home editorial rules (site rules + October 2026 SEO audit)

These articles are live editorial claims on an Australian affiliate site. An
article that breaks these rules is held back as a draft, so follow them exactly.

Facts and honesty
- State only what the research notes confirm, or what is common, stable
  knowledge (what Zigbee is, how a smart plug works). Confirm every model
  name, spec, compatibility claim, warranty and figure in the notes; leave out
  anything you cannot confirm.
- Never construct a URL. Link only to URLs that appear in the research notes or
  the internal-link list.
- We have not tested these products. No "we tested", "we found", "in our
  testing", "in our experience", "hands-on"; no star ratings or scores; never
  call the article a review.
- Prices: none, unless the research notes give one with its retailer, and then
  attributed and dated ("JB Hi-Fi listed it at $99 in October 2026").

Legal and safety (electrical work, privacy and surveillance, tenancy and strata)
- Never state the law as settled. Say what the official source says and link
  to it from the research notes (state electrical safety regulator, OAIC,
  state tenancy authority), or point readers to it.
- Fixed wiring: "must be done by a licensed electrician" and point to the state
  regulator. Never "done or checked by an electrician".

Structure
- Open with a 40-60 word direct answer to the question in the title, as a plain
  paragraph before the first heading. Answer it outright; do not introduce the
  topic.
- Use question-form H2s where they read naturally ("Can I install a smart
  switch myself?"), not labels ("The rule, plainly").
- Keep sentences under ${SENTENCE_MAX} words. Short paragraphs.
- Comparison, buying-guide and roundup articles include a Markdown comparison
  table, using only figures the research notes confirm; leave a cell as "Not
  stated" rather than guess.
- Product boxes: place a catalogue product only where the article genuinely
  discusses that kind of product. Never add a sentence or section just to
  mention one (a security camera in a smoke-alarm article is an ad, not
  content, CLAUDE.md rule 3). Placing none is better than placing one that
  does not belong; the editor then finds a product or holds the article.
- Link 2-4 related NXT Smart Home articles from the internal-link list, with
  descriptive anchor text, where they genuinely help. Use the URLs exactly.
- End with "## Sources": the official and manufacturer pages from the research
  notes that the article relies on, as a Markdown list of links.

Titles and metadata
- seoTitle at most ${TITLE_MAX} characters, none of "tested",
  "hands-on", "honest", "ultimate", "verified", "review".
- The title (H1) may be longer, but keep it plain and specific.
- seoDescription ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX} characters, plain text, describing what the article
  actually covers.

Style
- Australian English: colour, optimise, centre, analyse, licence (noun), metre.
- Plain and specific. None of: ${HYPE_PHRASES.join(', ')}.
- No keyword stuffing; never promise rankings or results.`;

/** Research brief for researchJson(): what to confirm before writing. */
export function researchPrompt(topic, categoryLabel) {
  return `Research this NXT Smart Home article before it is written: "${topic}" (category: ${categoryLabel}).
The readers are Australian homeowners and renters. Use web search to confirm:
- the products, models and platforms the article will name: key specs, Australian availability, Matter / Apple Home / Google Home / Alexa / SmartThings / Home Assistant support, 2.4GHz needs, subscriptions, Australian warranty
- any electrical, privacy or tenancy point the topic touches, from the official Australian source (state electrical safety regulator, OAIC, state tenancy authority)
- Australian specifics: plug and voltage, RCM, local retailers that stock it
Prefer manufacturer Australian pages, Australian retailers and .gov.au sources.
Return only what you confirmed, each with the URL it came from. No prices unless a retailer page states one; then include the retailer and date.`;
}

export const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { fact: { type: 'string' }, url: { type: 'string' } },
        required: ['fact', 'url'],
        additionalProperties: false,
      },
    },
    officialSources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, url: { type: 'string' } },
        required: ['name', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts', 'officialSources'],
  additionalProperties: false,
};

export function researchNotes(research) {
  const facts = (research?.facts ?? []).map((f) => (f.url ? `- ${f.fact} (${f.url})` : `- ${f.fact}`)).join('\n');
  const official = (research?.officialSources ?? []).map((s) => `- ${s.name}: ${s.url}`).join('\n');
  return `\n\nResearch notes (web search, ${new Date().toISOString().slice(0, 10)}). The only specific facts you may use:\n${facts || '- (none confirmed)'}\n\nSource pages found (the ONLY external URLs you may link, copied exactly, character for character; never shorten one to its homepage or guess a path):\n${official || '- (none found)'}\n`;
}

/** Canonical URL of an article: category URL slug, trailing slash. */
export function articleUrl(categoryKey, slug) {
  const cat = CATEGORY_URL_SLUG[categoryKey] || categoryKey;
  return `${SITE_ORIGIN}/${cat}/${slug}/`;
}

/**
 * Rewrites links to the site's own articles to their canonical form (S1): the
 * category key becomes the URL slug and a trailing slash is added, absolute or
 * relative. /security/x -> /security-and-cameras/x/.
 */
export function canonicaliseInternalLinks(markdown) {
  const keys = Object.keys(CATEGORY_URL_SLUG).sort((a, b) => b.length - a.length).map((k) => k.replace(/[-]/g, '\\-'));
  const re = new RegExp(`\\]\\((?:https?://(?:www\\.)?nxtsmarthome\\.com\\.au)?/(${keys.join('|')})/([a-z0-9-]+)/?(#[^)\\s]*)?\\)`, 'g');
  return String(markdown).replace(re, (_, cat, slug, hash = '') => `](${articleUrl(cat, slug)}${hash})`);
}

/** Internal article links in the body, canonical form. */
export function internalLinks(markdown) {
  const out = new Set();
  for (const m of String(markdown).matchAll(/\]\((https?:\/\/(?:www\.)?nxtsmarthome\.com\.au\/[a-z0-9-]+\/[a-z0-9-]+\/)\)/g)) out.add(m[1]);
  return [...out];
}

/**
 * A URL the research returned, or the homepage of a site it returned (the
 * model links "https://www.energysafe.vic.gov.au" for a regulator it found a
 * deep page of). Deep paths must match exactly: those are the ones that get
 * invented.
 */
export function isAllowedUrl(url, allowedUrls) {
  const n = normaliseUrl(url);
  if (allowedUrls.has(n)) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.pathname.replace(/\/+$/, '') !== '' || u.search) return false;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  for (const a of allowedUrls) {
    try {
      if (new URL(a).hostname.replace(/^www\./, '') === host) return true;
    } catch {}
  }
  return false;
}

/*
 * Adds to allowedUrls every external link in the text that the research did
 * not list but that loads (HTTP 200 after redirects). Gemini's grounding data
 * lists only some of the pages it read, and the model links real official
 * pages it found (a state tenancy authority's smoke-alarm page); invented URLs
 * almost always 404. A site that refuses the check (403) stays unlinked.
 */
export async function verifyLiveUrls(markdown, allowedUrls, { timeoutMs = 10000 } = {}) {
  const urls = [...new Set(String(markdown).match(/https?:\/\/[^\s)\]"'>]+/g) ?? [])]
    .filter((u) => !/^https?:\/\/(?:www\.)?nxtsmarthome\.com\.au\//i.test(u) && !isAllowedUrl(u, allowedUrls));
  const live = [];
  await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; NXTSmartHome-linkcheck/1.0)' },
      });
      if (res.ok) {
        allowedUrls.add(normaliseUrl(url));
        live.push(url);
      }
    } catch {}
  }));
  return live;
}

/** Turns links to URLs the research did not return into plain text (anchor kept). */
export function unlinkUnsourced(markdown, allowedUrls) {
  const dropped = [];
  const text = String(markdown).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, anchor, url) => {
    if (/^https?:\/\/(?:www\.)?nxtsmarthome\.com\.au\//i.test(url) || isAllowedUrl(url, allowedUrls)) return m;
    dropped.push(url);
    return anchor;
  });
  // A Sources list item left with no link is no longer a source.
  return { text: text.replace(/^\s*[-*]\s+[^\[\n]*$\n?/gm, (line) => (/^\s*[-*]\s+\S/.test(line) && inSources(text, line) ? '' : line)), dropped };
}

function inSources(text, line) {
  const at = text.indexOf(line);
  const sources = text.search(/^##\s+Sources\s*$/im);
  return sources >= 0 && at > sources;
}

export function normaliseUrl(url) {
  return String(url).replace(/[.,;:]+$/, '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
}

function words(text) {
  return String(text).split(/\s+/).filter(Boolean).length;
}

function excerpt(text, at, len) {
  return text.slice(Math.max(0, at - 30), at + len + 30).replace(/\s+/g, ' ').trim();
}

/** Prose only: no tables, link targets, headings or list markers. */
function prose(markdown) {
  return String(markdown)
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*#/.test(l) && !/^::product:/.test(l.trim()))
    .join('\n')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[[\]*_`]/g, '');
}

function sentences(text) {
  return prose(text)
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((s) => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter((s) => words(s) >= 3);
}

/**
 * Checks a generated article against the rules. Returns a list of problems;
 * empty means it may be published.
 *
 *   post         { title, seoTitle, seoDescription, content, postType, faq? }
 *   allowedUrls  Set of normalised external URLs the research returned
 */
export function checkNxtsmarthomeContent(post, { allowedUrls = null } = {}) {
  const issues = [];
  const body = String(post.content || '');
  const faqText = (post.faq || []).map((f) => `${f.question} ${f.answer}`).join(' ');
  const all = `${post.title}\n${body}\n${faqText}`;

  if (post.seoTitle && post.seoTitle.length > TITLE_MAX) issues.push(`seoTitle is ${post.seoTitle.length} characters (max ${TITLE_MAX})`);
  for (const [label, t] of [['title', post.title], ['seoTitle', post.seoTitle]]) {
    const m = String(t || '').match(TITLE_BANNED);
    if (m) issues.push(`${label} contains "${m[0]}"`);
  }
  const dl = String(post.seoDescription || '').length;
  if (dl < META_DESCRIPTION_MIN || dl > META_DESCRIPTION_MAX) issues.push(`seoDescription is ${dl} characters (want ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX})`);

  // GEO-4: a direct answer before the first heading.
  const lead = body.split(/\n#{2,3}\s/)[0].split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('::product:'))[0] || '';
  const leadWords = words(prose(lead));
  if (leadWords < SHORT_ANSWER_WORDS[0] - 5 || leadWords > SHORT_ANSWER_WORDS[1] + 15) {
    issues.push(`opening answer is ${leadWords} words (want ${SHORT_ANSWER_WORDS[0]}-${SHORT_ANSWER_WORDS[1]}, before the first heading)`);
  }

  // C7: long sentences.
  const ss = sentences(body);
  const long = ss.filter((s) => words(s) > SENTENCE_MAX + 5);
  const avg = ss.length ? ss.reduce((n, s) => n + words(s), 0) / ss.length : 0;
  if (avg > 22) issues.push(`average sentence is ${avg.toFixed(1)} words (want 22 or fewer)`);
  if (long.length > 3) issues.push(`${long.length} sentences over ${SENTENCE_MAX + 5} words, e.g. "${long[0].slice(0, 90)}..."`);

  // GEO-4: at least some question-form H2s.
  const h2 = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]).filter((h) => !/^(sources|frequently asked questions|faqs?)$/i.test(h.trim()));
  if (h2.length >= 3 && !h2.some((h) => /\?\s*$/.test(h))) issues.push('no question-form H2 headings');

  // S1: internal links.
  const links = internalLinks(body);
  if (links.length < INTERNAL_LINKS_MIN) issues.push(`${links.length} internal article links (want ${INTERNAL_LINKS_MIN}-4)`);
  if (/\]\(\/(?:security|energy|entertainment|climate)\//.test(body)) issues.push('internal link uses a category key path (redirects)');

  // GEO-6: comparison table for comparison-type articles.
  const type = post.postType || '';
  if (['product-comparison', 'buying-guide', 'product-roundup'].includes(type) && !/^\s*\|.*\|\s*$/m.test(body)) {
    issues.push(`no comparison table (${type})`);
  }

  // Sources and URL provenance.
  if (!/^##\s+Sources\s*$/im.test(body)) issues.push('no "## Sources" section');
  if (allowedUrls) {
    for (const url of body.match(/https?:\/\/[^\s)\]"'>]+/g) ?? []) {
      if (/^https?:\/\/(?:www\.)?nxtsmarthome\.com\.au\//i.test(url)) continue;
      if (!isAllowedUrl(url, allowedUrls)) issues.push(`URL not from research: ${url}`);
    }
  }

  // Rules 5 and 6: testing, ratings, legal claims.
  for (const [label, re] of [
    ['testing claim', TESTING], ['star rating or score', RATING], ['"or checked by an electrician" (C6)', OR_CHECKED],
    ['law stated as settled', LAW_AS_SETTLED], ['editorial marker', EDITORIAL_MARKERS],
  ]) {
    const m = all.match(re);
    if (m) issues.push(`${label}: "${excerpt(all, m.index, m[0].length)}"`);
  }
  if (LEGAL_TOPIC.test(body) && !OFFICIAL_SOURCE.test(body)) {
    issues.push('covers electrical, privacy or tenancy rules but links no official (.gov.au or regulator) source (GEO-1)');
  }
  for (const line of body.split('\n')) {
    if (PRICE.test(line) && !/\]\(https?:/.test(line) && !/^\s*\|/.test(line)) {
      issues.push(`price without a linked source: "${line.trim().slice(0, 90)}"`);
      break;
    }
  }

  // Style.
  const lower = all.toLowerCase();
  for (const p of HYPE_PHRASES) if (new RegExp(`\\b${p.replace(/[-']/g, (c) => `\\${c}`)}\\b`).test(lower)) issues.push(`filler phrase: "${p}"`);
  const us = prose(all).match(US_SPELLING);
  if (us) issues.push(`US spelling: "${us[0]}"`);
  if (/\\n/.test(body)) issues.push('escaped newlines (\\n) in the text');

  return issues;
}

/**
 * Near-duplicate test for a topic against existing titles (C3). Words are
 * weighted by rarity across all titles, so "smart home australia" counts for
 * little and "ducted zoning" for a lot.
 */
export function nearDuplicateOf(topic, titles) {
  const df = new Map();
  for (const t of titles) for (const w of titleWords(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = Math.max(titles.length, 1);
  const weight = (w) => Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const x = titleWords(topic);
  if (x.size < 2) return null;
  for (const t of titles) {
    const y = titleWords(t);
    if (y.size < 2) continue;
    let shared = 0;
    let total = 0;
    for (const w of new Set([...x, ...y])) {
      total += weight(w);
      if (x.has(w) && y.has(w)) shared += weight(w);
    }
    // 0.38, tuned on the live titles (Oct 2026): catches the audit's camera-storage and
    // neutral-switch pairs (0.41), leaves robot-vacuum guide vs stick vacuum (0.37) apart.
    if (shared / total >= 0.38) return t;
  }
  return null;
}

const STOP = new Set(('a an and are as at be best by can do does for from guide how i in into is it its of on or should '
  + 'the to vs what when where which who why will with without you your aussie australia australian australians au '
  + 'home homes smart need needs that this').split(' '));

function titleWords(s) {
  const w = String(s).toLowerCase().replace(/\b20\d\d\b/g, '').match(/[a-z0-9]+/g) ?? [];
  return new Set(w.filter((x) => x.length > 1 && !STOP.has(x)).map((x) => (x.length > 3 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x)));
}

/*
 * Gemini, for running the writer on a Gemini key (owner's request, Oct 2026;
 * an exception to /opt/CLAUDE.md's Anthropic-only rule, kept to this writer).
 */
export async function geminiGenerate({ apiKey, model, body }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
      continue;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }
  throw new Error('Gemini: gave up after repeated 429/5xx');
}

export function geminiText(json) {
  return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

/*
 * Research with Google Search grounding. A short research-only prompt: given a
 * long brief, Gemini often skips the search and answers from memory (seen on
 * the product notes, 6 Oct 2026). Up to three tries until it actually
 * searched. Returns the same shape as researchJson(): { json: { facts,
 * officialSources }, searchedUrls }, with the grounding sources resolved from
 * Google's redirect links to the real pages.
 */
export async function researchWithGemini({ apiKey, model, prompt }) {
  let notes = '';
  let urls = [];
  for (let attempt = 0; attempt < 3 && !urls.length; attempt++) {
    const json = await geminiGenerate({
      apiKey,
      model,
      body: {
        contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nList each confirmed fact as a bullet point naming the site it came from.` }] }],
        tools: [{ google_search: {} }],
      },
    });
    notes = geminiText(json);
    urls = await groundingUrls(json);
  }
  const facts = notes.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()).filter((l) => l.length > 15).map((fact) => ({ fact, url: '' }));
  const officialSources = urls.map((url) => ({ name: new URL(url).hostname.replace(/^www\./, ''), url }));
  return { json: { facts, officialSources }, searchedUrls: new Set(urls.map(normaliseUrl)) };
}

async function groundingUrls(json) {
  const out = [];
  for (const c of (json.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).slice(0, 15)) {
    const uri = c.web?.uri;
    if (!uri) continue;
    let real = uri;
    try {
      real = (await fetch(uri, { redirect: 'manual' })).headers.get('location') || uri;
    } catch {}
    if (!/vertexaisearch|grounding-api-redirect/.test(real) && !out.includes(real)) out.push(real);
  }
  return out;
}
