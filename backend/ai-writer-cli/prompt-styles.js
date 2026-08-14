/**
 * Selectable article-writing styles for generate-site-post.js.
 *
 * These carry the *method* of the two hand-written prompts, not their output
 * format. The generator requires strict JSON with a fixed set of keys, which it
 * then feeds to image generation and the Strapi write — a prompt that asked for
 * a human-readable document with numbered sections would break the parse and
 * take the rest of the pipeline with it.
 *
 * So the research steps and writing rules are kept, and the deliverables are
 * mapped onto keys the pipeline already understands:
 *
 *   SEO title under 60 chars      -> seoTitle
 *   Meta description under 155    -> seoDescription
 *   Suggested URL slug            -> slug
 *   H1/H2/H3 outline + article    -> content
 *   FAQ, examples, internal links -> inside content
 *
 * The parts with nowhere to live — search intent, inferred keywords, the angle,
 * facts needing verification, the editorial checklist — go into an optional
 * `editorialNotes` object. The generator prints it and does not store it, so it
 * appears in the job log for review without inventing Strapi fields.
 */

const RANK_ON_GOOGLE = `
ARTICLE STYLE: rank-on-google

Before writing, work out and record in "editorialNotes":
- primaryKeyword: the likely primary keyword
- secondaryKeywords: the likely secondary keywords
- searchIntent: what the reader is actually trying to do
- audience: who this is for
- angle: the content angle you chose
- betterThanGeneric: what this article must include to beat generic search results
- verifyThese: any fact a reader or editor should verify before publishing
- checklist: a short final editorial checklist

Then write the article to these rules:
- The introduction must directly answer the reader's problem, not warm up to it.
- Prioritise reader usefulness over keyword repetition. Never keyword-stuff.
- Add original insight: examples, comparisons, trade-offs, practical advice.
- Include practical examples with specifics rather than generalities.
- Include an FAQ section covering questions a real reader would ask.
- Use short paragraphs and clear H2/H3 headings so the page is scannable.
- Say plainly where a fact needs verification rather than stating it confidently.
- Never promise or imply search rankings.
- No filler, no padding to reach a word count.
- End with a genuinely helpful conclusion and a natural call to action.

Constraints that map onto the JSON keys:
- "seoTitle" must be under 60 characters.
- "seoDescription" must be under 155 characters.
- "slug" must be a clean, readable URL slug.
`.trim();

const UNIQUE_SEO = `
ARTICLE STYLE: unique-seo

Before writing, work out and record in "editorialNotes":
- searchIntent: the intent behind the primary keyword
- primaryKeyword and secondaryKeywords
- audience and region: who and where this is for
- angle: how this article adds value beyond generic search results
- verifyThese: facts that need checking, with a source if you have one
- checklist: what to confirm before publishing

Then write the article to these rules:
- Write for humans first and search engines second.
- Use the primary keyword naturally in the title, the introduction, one heading
  and the conclusion. Use related terms only where they genuinely fit.
- Add original insight: examples, comparisons, specific detail, expert-style
  explanation. Avoid generic AI-sounding phrasing.
- Do not repeat the same idea in different words.
- Include an FAQ section only if the questions are genuinely useful. Omit it
  otherwise rather than padding.
- Keep paragraphs short so the article is easy to scan.
- Cite sources for web-derived facts, or state clearly where verification is
  needed.
- Never claim the article is human-written, unique, or plagiarism-free.
- Never exaggerate and never promise rankings.
- Accuracy, usefulness and trust matter more than hitting a word count.
- End with a helpful conclusion and a natural call to action.

Constraints that map onto the JSON keys:
- "seoTitle" must be under 60 characters.
- "seoDescription" must be under 155 characters.
- "slug" must be a clean, readable URL slug.
`.trim();

export const PROMPT_STYLES = {
  default: { label: 'Default (site editorial brief only)', instructions: '' },
  'rank-on-google': { label: 'Best article to rank on Google', instructions: RANK_ON_GOOGLE },
  'unique-seo': { label: 'Human-written, unique, SEO optimised', instructions: UNIQUE_SEO },
};

export const PROMPT_STYLE_KEYS = Object.keys(PROMPT_STYLES);

/** The extra JSON key a style asks for, appended to the schema when in use. */
export const EDITORIAL_NOTES_SCHEMA = `
  "editorialNotes": {
    "primaryKeyword": string,
    "secondaryKeywords": string,
    "searchIntent": string,
    "audience": string,
    "angle": string,
    "verifyThese": [string],
    "checklist": [string]
  }`;
