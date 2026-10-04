// Content rules for everything the ai-writer-cli generates for originfacts.com.
//
// They come from the site's audits: the September 2026 AdSense rejection
// ("low value content": sibling pages sharing 53-70% of their text, fleet-wide
// default "facts", constructed citations) and the October SEO re-audit
// (invented price tables, boilerplate appended to every intro, stale years and
// "(Tested)"/"Honest" in titles, titles over 60 characters). The retired
// "Melbourne design hotels opening 2026" article, whose seven openings did not
// exist, is the reason claims about the future are out.
//
// Every originfacts generator imports this module to:
//   - put ORIGINFACTS_RULES in its system prompt,
//   - run checkOriginfactsContent() on what the model returns before writing,
//   - and, where facts are stated, research with researchJson() so that named
//     places and figures come from search results rather than recall.

export const TITLE_MAX = 60; // lib/seo.ts compactTitle cap on the site
export const META_DESCRIPTION_MAX = 155;
export const SIBLING_OVERLAP_MAX = 0.2; // share of six-word sequences also on a sibling page

export const BANNED_PHRASES = [
  'nestled', 'hidden gem', 'bustling', "a stone's throw", 'picture-perfect', 'must-see', 'must-visit',
  'world-class', 'breathtaking', 'plethora', 'myriad', 'vibrant tapestry', 'tapestry', 'rest assured',
  'look no further', 'immerse yourself', 'embark on', 'something for everyone', 'whether you\'re a seasoned',
  'in conclusion', 'at the end of the day', 'hassle-free',
];

export const ORIGINFACTS_RULES = `# Originfacts editorial rules (from the site's SEO and AdSense audits)

These pages are live editorial claims on an affiliate site. A page that breaks
these rules is withheld, so follow them exactly.

Facts
- State only what you can confirm. When web search is available, confirm every
  named place, operator, route, figure and date with it; leave out anything you
  cannot confirm. Round numbers a source gives ("about 30 minutes").
- No prices, fares, fees, rates or exchange rates. Describe price patterns
  instead (cheapest months, budget vs premium options, what drives the cost).
- Nothing about the future or the very recent: no openings, closures,
  renovations, "new in <year>", upcoming events or current construction.
- No visa or entry rules beyond pointing to the official government source;
  never state fees, durations or nationality lists.
- No invented statistics, rankings or "studies show".
- Never construct a URL or citation. Cite only pages you actually found.
- No claims about how the content was made ("tested", "verified by experts",
  "official sources", "we analysed"), and no first-person experience ("I
  booked", "we stayed", "we flew", "we tested"). Write as an informed guide,
  not as a reviewer who was there.

Uniqueness
- Write about this one subject. Every paragraph must be impossible to reuse
  for another city, airline, airport or route by swapping the name.
- No template sentences, no generic travel advice that fits anywhere ("book
  early", "check schedules online", "public transport is efficient"), no
  closing summary paragraph.
- No filler words: ${BANNED_PHRASES.join(', ')}.

Titles and metadata
- Titles at most ${TITLE_MAX} characters, no year, no "!!", and none of
  "tested", "honest", "ultimate", "best ever", "verified".
- Meta descriptions at most ${META_DESCRIPTION_MAX} characters, plain text,
  describing what the page actually contains.

Style: British English, plain and specific. Concrete nouns (named districts,
stations, operators, months) over adjectives.`;

const PRICE = /[$€£¥฿₩₹]\s?\d|\b\d[\d,.]*\s?(?:USD|AUD|EUR|GBP|THB|JPY|CNY|RMB|SGD|HKD|NZD|CAD|baht|yen|yuan|dollars|euros|pounds|rupees?|dong|rupiah)\b/i;
const FUTURE = /\b(?:newly|recently) (?:opened|reopened|launched)\b|\bopen(?:s|ing)? (?:in 20\d\d|soon|later this year)\b|\bunder construction\b|\bwill (?:open|launch|reopen)\b|\bcoming soon\b|\bnew in 20\d\d\b/i;
const VISA_SPECIFICS = /\bvisa\b[^.]{0,80}\b(?:\d+[- ]days?|fee|costs?|free for|nationalit)/i;
const FIRST_PERSON = /\b(?:I|we)\s+(?:booked|stayed|flew|tested|tried|visited|found|spent|paid|ate|took|rode|checked in|loved)\b/i;
const PROCESS_CLAIMS = /\b(?:we (?:tested|analy[sz]ed|verified|reviewed)|tested by|verified by|expert[- ]verified|rigorous(?:ly)? (?:tested|verified)|official sources confirm)\b/i;
const TITLE_BANNED = /\b20\d\d\b|!!|\b(?:tested|honest|ultimate|best ever|verified)\b/i;

/**
 * Checks generated content against the rules. Returns a list of problems;
 * empty means it may be written.
 *
 *   fields   { title?, seoTitle?, seoDescription?, body (all prose, joined) }
 *   siblings optional array of other pages' text of the same kind, for the
 *            template-text check
 *   allowedUrls optional Set of URLs the research actually returned
 */
export function checkOriginfactsContent({ title, seoTitle, seoDescription, body = '' }, { siblings = [], allowedUrls = null } = {}) {
  const issues = [];
  for (const [label, t] of [['title', title], ['seoTitle', seoTitle]]) {
    if (!t) continue;
    if (t.length > TITLE_MAX) issues.push(`${label} is ${t.length} characters (max ${TITLE_MAX})`);
    const m = t.match(TITLE_BANNED);
    if (m) issues.push(`${label} contains "${m[0]}"`);
  }
  if (seoDescription && seoDescription.length > META_DESCRIPTION_MAX) {
    issues.push(`seoDescription is ${seoDescription.length} characters (max ${META_DESCRIPTION_MAX})`);
  }
  for (const [label, re] of [
    ['price', PRICE], ['future claim', FUTURE], ['visa specifics', VISA_SPECIFICS],
    ['first-person experience', FIRST_PERSON], ['process claim', PROCESS_CLAIMS],
  ]) {
    const m = body.match(re);
    if (m) issues.push(`${label}: "${excerpt(body, m.index, m[0].length)}"`);
  }
  const lower = body.toLowerCase();
  for (const p of BANNED_PHRASES) if (lower.includes(p)) issues.push(`filler phrase: "${p}"`);
  if (/\\n/.test(body)) issues.push('escaped newlines (\\n) in the text');
  if (allowedUrls) {
    for (const url of body.match(/https?:\/\/[^\s)\]"']+/g) ?? []) {
      if (!allowedUrls.has(normaliseUrl(url))) issues.push(`URL not from research: ${url}`);
    }
  }
  if (siblings.length) {
    const share = siblingOverlap(body, siblings);
    if (share > SIBLING_OVERLAP_MAX) issues.push(`${Math.round(share * 100)}% of the text also appears on sibling pages (max ${SIBLING_OVERLAP_MAX * 100}%)`);
  }
  return issues;
}

/** Share of a text's six-word sequences that also occur in any sibling text. */
export function siblingOverlap(text, siblings) {
  const mine = sixGrams(text);
  if (!mine.size) return 0;
  const theirs = new Set();
  for (const s of siblings) for (const g of sixGrams(s)) theirs.add(g);
  let shared = 0;
  for (const g of mine) if (theirs.has(g)) shared++;
  return shared / mine.size;
}

function sixGrams(text) {
  const w = String(text).toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Set();
  for (let i = 0; i + 6 <= w.length; i++) out.add(w.slice(i, i + 6).join(' '));
  return out;
}

/**
 * Near-duplicate test for article titles: the same angle under a new title,
 * like the airport-vs-city car-rental pair the September audit hid.
 *
 *   corpus  every known title (existing articles and queued topics); words
 *           are weighted by rarity across it, so "travel tips" counts for
 *           little and a specific subject for a lot
 *   places  destination names the site knows ("bangkok", "new york")
 *
 * Titles about different places are never duplicates ("Perth to Chennai
 * flights" vs "Perth to Hamburg flights"); titles about the same places, or
 * none, are duplicates when most of their weighted wording is shared.
 */
export function titleMatcher(corpus, places = []) {
  const df = new Map();
  for (const t of corpus) for (const w of titleWords(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = Math.max(corpus.length, 1);
  const weight = (w) => Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const placeRes = [...new Set(places.map((p) => p.toLowerCase().trim()).filter((p) => p.length > 2))]
    .map((p) => [p, new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')]);
  const placesIn = (t) => new Set(placeRes.filter(([, re]) => re.test(t)).map(([p]) => p));
  return (a, b) => {
    const pa = placesIn(a);
    const pb = placesIn(b);
    if (pa.size !== pb.size || [...pa].some((p) => !pb.has(p))) return false;
    const x = titleWords(a);
    const y = titleWords(b);
    if (!x.size || !y.size) return false;
    let shared = 0;
    let all = 0;
    for (const w of new Set([...x, ...y])) {
      all += weight(w);
      if (x.has(w) && y.has(w)) shared += weight(w);
    }
    return shared / all >= 0.6;
  };
}

function titleWords(s) {
  const words = String(s).toLowerCase().replace(/\b20\d\d\b/g, '').match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map((w) => w.replace(/s$/, '')));
}
const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'from', 'how', 'what', 'that', 'this', 'are', 'can', 'you', 'into', 'its', 'who', 'why', 'when', 'where', 'which', 'need', 'needs', 'every', 'real', 'answer']);

export function normaliseUrl(url) {
  return String(url).replace(/[.,;:]+$/, '').replace(/\/$/, '').toLowerCase();
}

function excerpt(text, at, len) {
  return text.slice(Math.max(0, at - 30), at + len + 30).replace(/\s+/g, ' ').trim();
}

/**
 * Asks Claude for one JSON object, researched with server-side web search.
 * Returns { json, searchedUrls (Set, normalised), usage }.
 *
 * Uses the Messages API directly: the SDK in this package predates
 * structured outputs and the current web search tool. No `temperature`
 * (current models reject it).
 */
export async function researchJson({ apiKey, model, system, prompt, schema, maxSearches = 6, maxTokens = 16000 }) {
  const messages = [{ role: 'user', content: prompt }];
  const searchedUrls = new Set();
  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        tools: maxSearches > 0 ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }] : undefined,
        output_config: schema ? { format: { type: 'json_schema', schema } } : undefined,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const msg = await res.json();
    for (const block of msg.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) searchedUrls.add(normaliseUrl(r.url));
      }
    }
    if (msg.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: msg.content });
      continue;
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    if (msg.stop_reason === 'max_tokens') throw new Error(`Response hit max_tokens (${maxTokens}).`);
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { json: JSON.parse(text), searchedUrls, usage: msg.usage };
  }
  throw new Error('Web search did not finish in 6 turns.');
}
