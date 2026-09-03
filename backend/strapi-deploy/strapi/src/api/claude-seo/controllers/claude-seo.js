'use strict';

const Anthropic = require('@anthropic-ai/sdk');

function parseJson(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(source);
}

async function configuredSecret() {
  const fromEnvironment = String(process.env.CLAUDE_SEO_SHARED_SECRET || '');
  if (fromEnvironment) return fromEnvironment;

  const wpUrl = String(process.env.WP_URL || '').replace(/\/$/, '');
  const user = String(process.env.WP_USER || '');
  const password = String(process.env.WP_APP_PASSWORD || '');
  if (!wpUrl || !user || !password) return '';

  const response = await fetch(`${wpUrl}/wp-json/flightfares-strapi/v1/claude-seo/config`, {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
  });
  if (!response.ok) return '';
  const body = await response.json();
  return String(body?.secret || '');
}

async function generateContentAssistant(client, input) {
  const action = String(input.action || 'full_audit');
  const instructions = {
    research_brief: 'Create a practical content brief: audience, search intent, angle, questions to answer, factual inputs needed, structure, and risks. Do not claim live SERP or search-volume research.',
    outline: 'Create a detailed article outline using logical H2 and H3 headings. Add a short note beneath each heading describing what it should cover.',
    article: 'Write a complete, useful long-form article in clean WordPress-compatible HTML. Use H2/H3 headings, short paragraphs, lists where useful, and no markdown.',
    write_section: 'Write one publication-ready section in clean HTML based on the instruction and surrounding article.',
    rewrite: 'Rewrite only the selected text for clarity, flow, accuracy, and usefulness while preserving its meaning and any links.',
    expand: 'Expand only the selected text with genuinely useful explanation and examples. Do not add filler or unverified claims.',
    shorten: 'Shorten only the selected text while preserving all essential facts and meaning.',
    clarity: 'Improve only the selected text for readability, directness, structure, and plain language.',
    grammar: 'Correct grammar, spelling, punctuation, and awkward phrasing in only the selected text. Preserve voice and meaning.',
    tone: 'Rewrite only the selected text in the requested tone while preserving facts, links, and meaning.',
    faq: 'Create 5 to 8 genuinely useful FAQs answered from the supplied article. Return clean HTML with H3 questions and concise answers.',
    headings: 'Suggest an improved H2/H3 hierarchy for the article, avoiding duplicate title intent and keyword stuffing.',
    seo_meta: 'Generate a Rank Math SEO title under 60 characters, meta description under 155 characters, and one natural focus keyword. The output should briefly explain the choices.',
    image_alt: 'Generate concise, accessible featured-image alt text. Do not describe visual details that were not supplied; use the title and article context conservatively.',
    internal_links: 'Suggest relevant internal links using only the approved URLs supplied. Include suggested anchor text and a natural placement for each.',
    external_sources: 'Identify claims that would benefit from authoritative external sources and recommend source types or official organizations. Do not invent URLs or citations.',
    keyword_coverage: 'Assess topical and semantic coverage. Suggest natural related phrases, missing reader questions, and specific sections to improve. Do not claim search volume or difficulty.',
    introduction: 'Write an improved introduction that answers the main intent quickly, sets expectations, and avoids a slow generic opening.',
    conclusion: 'Write an improved concise conclusion with a useful next step and no exaggerated claims.',
    fact_check: 'List factual, legal, price, schedule, policy, statistical, or time-sensitive claims that require verification. Explain what authoritative source should verify each.',
    social: 'Create platform-ready promotional copy for Facebook, X, LinkedIn, and an email teaser without inventing claims.',
    full_audit: 'Audit usefulness, structure, clarity, intent coverage, on-page SEO, internal links, sourcing, freshness, accessibility, and conversion. Prioritize actionable improvements.',
  };
  if (!instructions[action]) throw new Error('Unsupported Claude content action.');

  const title = String(input.title || '').trim();
  const content = String(input.content || '').trim().slice(0, 32000);
  const selectedText = String(input.selectedText || '').trim().slice(0, 12000);
  const instruction = String(input.instruction || '').trim().slice(0, 2000);
  if (!title || !content) throw new Error('A post title and content are required.');

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: action === 'article' ? 5000 : 2800,
    system: 'You are the senior content and SEO editor for FlightFares.one. Be helpful, accurate, concise, and transparent. Never invent prices, schedules, policies, statistics, sources, URLs, or first-hand experience. Return strict JSON only. Content output must be clean WordPress-compatible HTML, never Markdown.',
    messages: [{
      role: 'user',
      content: `${instructions[action]}\n\nOptional editor instruction: ${instruction || 'None'}\nTitle: ${title}\nCurrent SEO title: ${String(input.currentSeoTitle || '')}\nCurrent description: ${String(input.currentSeoDescription || '')}\nCurrent focus keyword: ${String(input.currentFocusKeyword || '')}\nSelected text (use this as the target for selection actions): ${selectedText || 'None'}\nApproved internal links: ${JSON.stringify(Array.isArray(input.internalLinks) ? input.internalLinks.slice(0, 80) : [])}\nArticle HTML: ${content}\n\nReturn exactly this JSON shape. Use empty strings or arrays for fields not relevant to the action:\n{"format":"html","output":"the requested HTML output or a structured HTML report","seoTitle":"","seoDescription":"","focusKeyword":"","imageAlt":"","suggestions":["concise follow-up or human-review item"]}`,
    }],
  });
  const text = response.content?.find((part) => part.type === 'text')?.text;
  const result = parseJson(text);
  return {
    format: ['html', 'text', 'json'].includes(result.format) ? result.format : 'html',
    output: String(result.output || ''),
    seoTitle: String(result.seoTitle || '').slice(0, 60),
    seoDescription: String(result.seoDescription || '').slice(0, 155),
    focusKeyword: String(result.focusKeyword || '').slice(0, 100),
    imageAlt: String(result.imageAlt || '').slice(0, 180),
    suggestions: Array.isArray(result.suggestions) ? result.suggestions.slice(0, 20).map(String) : [],
  };
}

module.exports = {
  async generate(ctx) {
    const expected = await configuredSecret();
    const supplied = String(ctx.request.headers['x-flightfares-claude-secret'] || '');
    if (!expected || !supplied || supplied.length !== expected.length || !require('crypto').timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return ctx.unauthorized('Invalid Claude SEO credentials.');
    }
    if (!process.env.ANTHROPIC_API_KEY) return ctx.serviceUnavailable('Anthropic is not configured.');

    const input = ctx.request.body || {};
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    if (input.type === 'content') {
      try {
        ctx.body = await generateContentAssistant(client, input);
      } catch (error) {
        strapi.log.error(`[claude-content] ${error.message}`);
        return ctx.internalServerError('Claude could not complete this content action. Please retry; no WordPress content was changed.');
      }
      return;
    }
    const mode = input.mode === 'optimize' ? 'optimize' : 'metadata';
    const allowedTasks = ['basic', 'additional', 'title', 'full'];
    const selectedTask = allowedTasks.includes(input.task) ? input.task : 'full';
    const title = String(input.title || '').trim();
    const rawContent = String(input.content || '').trim();
    const content = (mode === 'optimize' ? rawContent : rawContent.replace(/\s+/g, ' ')).slice(0, 24000);
    if (!title || !content) return ctx.badRequest('A post title and content are required.');

    const outputShape = mode === 'optimize'
      ? '{"seoTitle":"under 60 characters with focus keyword near the beginning","seoSlug":"short lowercase URL slug containing focus keyword","seoDescription":"under 155 characters containing focus keyword","focusKeyword":"one natural primary keyphrase","imageAlt":"natural featured-image alt text containing the focus keyword","contentPatches":[{"find":"an exact short passage copied verbatim from Content","replace":"improved replacement HTML"}],"checks":{"basicSeo":["fixes covered"],"additionalSeo":["fixes covered"],"titleReadability":["fixes covered"]},"recommendations":["only remaining actions requiring a verified external URL or human choice"]}'
      : '{"seoTitle":"under 60 characters","seoSlug":"short lowercase URL slug using hyphens","seoDescription":"under 155 characters","focusKeyword":"one natural primary keyphrase","recommendations":["up to three concise actionable content improvements"]}';
    const taskInstructions = {
      basic: 'Fix only Rank Math Basic SEO: focus keyword in SEO title, meta description, URL, opening paragraph, and natural distribution. Return at most 4 content patches.',
      additional: 'Fix only Rank Math Additional SEO: keyword in H2/H3 headings, featured-image alt text, natural density, and internal links using only supplied URLs. Return at most 5 content patches. Put external-link needs in recommendations.',
      title: 'Fix only Rank Math Title Readability. Create an accurate title under 60 characters with the focus keyword near the beginning. Use a number, sentiment, or power word only when truthful. Return no content patches.',
      full: 'Audit Rank Math Basic SEO, Additional SEO, and Title Readability together. Return at most 8 content patches.',
    };
    const task = mode === 'optimize'
      ? `${taskInstructions[selectedTask]} Return small targeted edits, not a rewritten article. Each find value must be copied exactly from Content, be 500 characters or fewer, and each replacement must preserve facts and valid HTML. Do not invent external URLs, statistics, claims, or images.`
      : 'Create Rank Math-compatible SEO metadata for this WordPress page.';
    const response = await client.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: mode === 'optimize' ? 2600 : 1200,
      system: 'You are a senior SEO editor. Return strict JSON only. Be accurate, useful, natural, and avoid keyword stuffing.',
      messages: [{ role: 'user', content: `${task}\n\nTitle: ${title}\nCurrent permalink slug: ${String(input.currentSlug || '')}\nExcerpt: ${String(input.excerpt || '')}\nCurrent SEO title: ${String(input.currentSeoTitle || '')}\nCurrent meta description: ${String(input.currentSeoDescription || '')}\nCurrent focus keyword: ${String(input.currentFocusKeyword || '')}\nApproved internal links: ${JSON.stringify(Array.isArray(input.internalLinks) ? input.internalLinks.slice(0, 40) : [])}\nContent: ${content}\n\nFor fields outside the selected task, preserve current values when supplied. Return exactly:\n${outputShape}` }],
    });
    const text = response.content?.find((part) => part.type === 'text')?.text;
    let result;
    try {
      result = parseJson(text);
    } catch (error) {
      strapi.log.error(`[claude-seo] Claude returned incomplete JSON (${response.stop_reason || 'unknown stop reason'}): ${error.message}`);
      return ctx.internalServerError('Claude could not complete the optimized article. Please retry; no WordPress content was changed.');
    }
    ctx.body = {
      seoTitle: String(result.seoTitle || '').slice(0, 60),
      seoSlug: String(result.seoSlug || '').slice(0, 75),
      seoDescription: String(result.seoDescription || '').slice(0, 155),
      focusKeyword: String(result.focusKeyword || '').slice(0, 100),
      imageAlt: String(result.imageAlt || '').slice(0, 180),
      contentPatches: Array.isArray(result.contentPatches) ? result.contentPatches.slice(0, 8) : [],
      checks: result.checks && typeof result.checks === 'object' ? result.checks : {},
      recommendations: Array.isArray(result.recommendations) ? result.recommendations.slice(0, 3) : [],
    };
  },
};
