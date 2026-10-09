#!/usr/bin/env node
// FXN AI Writer - fxnholdings.com blog post generator
//
// fxnholdings.com is a static site, not a Strapi frontend: posts are Markdown
// files in /opt/projects/fxnholdings.com/_src/posts/ that _src/build.py turns
// into /insights/<slug>/ pages (the menu calls the section "Blog"). This script
// writes those files directly. It does not touch Strapi.
//
// Categories are the site's real ones, read live from _src/insights.py
// (currently technology-ai, company-news, market-gaps), so a category added
// there shows up here with no change to this script.
//
// Every post is grounded in the site's own pages (About, What We Do,
// Technology & AI, Our Websites) and existing posts, and is saved as a DRAFT:
// the owner reviews it on https://preview.fxnholdings.com (it appears within
// about two seconds) and publishes by deleting the `draft: true` line.
//
// SEO rules from the 9 Oct 2026 audit (seo-reports/2026-10-09/seo-audit.md),
// enforced after generation, not just requested:
//   - title <= 45 chars, so "<title> | FXN Holdings" stays within 60
//   - description (search snippet) <= 155 chars; summary (cards) <= 220 chars
//   - slug from the title, lowercase-hyphenated, <= 60 chars, unique
//   - no H1 in the body (the page supplies it); 3-6 ## sections, each opening
//     with a 40-60 word direct answer (answer boxes / AI Overviews)
//   - at least 3 internal links, only to pages and posts that exist; unknown
//     internal links are unlinked
//   - only the Markdown the site renders (##/###, lists, >, ---, bold, italic,
//     code, links); tables and images are refused
//   - no invented facts: a second AI pass checks every claim about FXN Holdings
//     against the site's own pages, and numbers not on those pages are flagged;
//     both are listed in _src/posts/<slug>.verify.txt (the build only reads .md)
//     and the post stays a draft
//   - length: --words (default 1500); under 80% of it fails the checks
//   - images, all made with fal.ai via the site's _src/featured_images.py:
//     a featured image (image_prompt/image_alt; 800/1600 px webp + 1200x630 OG
//     jpg) and at least 2 images inside the post (--images, default 2), each
//     placed after the opening answer of the section it illustrates. On by
//     default; --no-image writes the post without generating them (the build
//     then refuses the post until the images exist).
//
// Examples:
//   node generate-fxnholdings-post.js                                  # prompts for category and topic
//   node generate-fxnholdings-post.js "Why we build on open source" --category technology-ai
//   node generate-fxnholdings-post.js --category market-gaps --count 2 # brainstorms 2 topics first
//   node generate-fxnholdings-post.js "..." --category company-news --image
//   node generate-fxnholdings-post.js "..." --category market-gaps --dry-run
//   node generate-fxnholdings-post.js "UK VAT for online sellers: when to register" --category start-a-business --research --provider gemini
//
// --research (for guides about the outside world, e.g. company set-up and VAT):
// Gemini with Google Search researches the topic first and only OFFICIAL sources
// are kept (government .gov / .gov.uk / gov.au / europa.eu and similar). The
// writer may state those facts as well as the site's own, links only to those
// official pages, and the post ends with an "Official sources (checked <date>)"
// list and a not-legal-or-tax-advice line. No official source found = no post.
// Uses Gemini (GEMINI_API_KEY), or OpenRouter web search with --provider openrouter.
//
// Provider: --provider anthropic (default; ANTHROPIC_API_KEY, model --model, else
// FXNHOLDINGS_MODEL, else claude-opus-5; no temperature, current models reject it),
// --provider gemini (GEMINI_API_KEY, model --model, else GEMINI_MODEL, else
// gemini-3.8-flash) or --provider openrouter (OPENROUTER_API_KEY, model --model,
// else OPENROUTER_MODEL, else anthropic/claude-opus-5.5; any id from
// https://openrouter.ai/models). With openrouter, --research uses OpenRouter's web
// search instead of Gemini, so it needs no Gemini key. The Gemini helpers below are self-contained, so this file
// needs nothing beyond what main already ships.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { input, select } from '@inquirer/prompts';
import { parseAiJson } from './parse-ai-json.js';

const SITE_DIR = process.env.FXNHOLDINGS_DIR || '/opt/projects/fxnholdings.com';
const POSTS_DIR = path.join(SITE_DIR, '_src', 'posts');
const PAGES_DIR = path.join(SITE_DIR, '_src', 'pages');
const PREVIEW = 'https://preview.fxnholdings.com';
const SUFFIX = ' | FXN Holdings';
const LIMITS = { title: 60 - SUFFIX.length, description: 155, summary: 220, slug: 60, minLinks: 3, minSections: 3, maxSections: 6 };
// Pages whose text is the factual ground truth for posts
const SOURCE_PAGES = ['index', 'about', 'services', 'technology', 'portfolio'];

const argv = yargs(hideBin(process.argv))
  .usage('$0 [topic] [options]')
  .option('category', { alias: 'c', type: 'string', describe: 'Category slug from _src/insights.py' })
  .option('count', { alias: 'n', type: 'number', default: 1, describe: 'Posts to write; without a topic, topics are brainstormed' })
  .option('words', { type: 'number', default: 1500, describe: 'Target length in words; under 80% fails the checks' })
  .option('images', { type: 'number', default: 2, describe: 'Images inside the post (at least 2)' })
  .option('image', { type: 'boolean', default: true, describe: 'Generate the featured and in-post images with fal.ai (--no-image to skip)' })
  .option('provider', { type: 'string', choices: ['anthropic', 'gemini', 'openrouter'], default: process.env.FXNHOLDINGS_PROVIDER || 'anthropic', describe: 'AI provider' })
  .option('model', { type: 'string', describe: 'Model id (default per provider)' })
  .option('title', { type: 'string', describe: 'Approved title to use exactly (max 45 chars); the topic defaults to it' })
  .option('research', { type: 'boolean', default: false, describe: 'Research official sources first (legal, tax, set-up guides)' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Print the post, write nothing' })
  .help()
  .parse();

const fatal = (msg) => { console.error(`error: ${msg}`); process.exit(1); };
const GEMINI = argv.provider === 'gemini';
const OPENROUTER = argv.provider === 'openrouter';
if ((GEMINI || (argv.research && !OPENROUTER)) && !process.env.GEMINI_API_KEY) fatal('GEMINI_API_KEY is not set in .env');
if (OPENROUTER && !process.env.OPENROUTER_API_KEY) fatal('OPENROUTER_API_KEY is not set in .env');
if (argv.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) fatal('ANTHROPIC_API_KEY is not set in .env');
if (!fs.existsSync(POSTS_DIR)) fatal(`${POSTS_DIR} not found (set FXNHOLDINGS_DIR)`);
const MODEL = argv.model || (GEMINI ? process.env.GEMINI_MODEL || 'gemini-3.8-flash'
  : OPENROUTER ? process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-5.5'
  : process.env.FXNHOLDINGS_MODEL || 'claude-opus-5');
const anthropic = argv.provider === 'anthropic' ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ---------------------------------------------------------------- site data

function loadCategories() {
  const src = fs.readFileSync(path.join(SITE_DIR, '_src', 'insights.py'), 'utf8');
  const block = src.match(/CATEGORIES = \[(.*?)\n\]/s)?.[1] || '';
  const cats = [...block.matchAll(/\{\s*"slug":\s*"([^"]+)",\s*"name":\s*"([^"]+)",\s*"icon":\s*"[^"]+",\s*"description":\s*"([^"]+)",?\s*\}/gs)]
    .map(([, slug, name, description]) => ({ slug, name, description }));
  if (!cats.length) fatal('could not read CATEGORIES from _src/insights.py');
  return cats;
}

function frontMatter(raw) {
  const m = raw.match(/^---\n(.*?)\n---\n/s);
  if (!m) return {};
  return Object.fromEntries(m[1].split('\n').filter((l) => l.includes(':')).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
}

function loadPosts() {
  return fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const meta = frontMatter(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8'));
    return { slug: f.slice(0, -3), title: meta.title || '', category: meta.category || '', summary: meta.summary || '', draft: meta.draft === 'true' };
  });
}

function pageText(name) {
  const raw = fs.readFileSync(path.join(PAGES_DIR, `${name}.html`), 'utf8');
  const meta = JSON.parse(raw.match(/<!--meta\s+(\{.*?\})\s*-->/s)?.[1] || '{}');
  const text = raw.replace(/<!--.*?-->/gs, ' ').replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return { path: meta.path, title: meta.title || name, text };
}

function linkTargets(posts) {
  const pages = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html') && f !== '404.html').map((f) => {
    const p = pageText(f.slice(0, -5));
    return { url: p.path, title: p.title };
  });
  const cats = loadCategories().map((c) => ({ url: `/insights/${c.slug}/`, title: `${c.name} (blog category)` }));
  const live = posts.filter((p) => !p.draft).map((p) => ({ url: `/insights/${p.slug}/`, title: p.title }));
  return [...pages, { url: '/insights/', title: 'Blog (all posts)' }, ...cats, ...live];
}

// ---------------------------------------------------------------- AI

// Gemini REST with retries on 429/5xx (same behaviour as the nxtsmarthome writer's helper).
async function geminiGenerate({ apiKey, model, body }) {
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

const geminiText = (json) => (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');

// Real page URLs behind Google Search grounding's redirect links.
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

// Research through OpenRouter's web search plugin with the --model in use.
async function researchWithOpenRouter({ prompt }) {
  let notes = '';
  let urls = [];
  for (let attempt = 0; attempt < 3 && !urls.length; attempt++) {
    ({ text: notes, urls } = await openrouter({ user: `${prompt}\n\nList each confirmed fact as a bullet point naming the site it came from.`, maxTokens: 6000, web: true }));
  }
  const facts = notes.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()).filter((l) => l.length > 15).map((fact) => ({ fact }));
  return { json: { facts, officialSources: urls.map((url) => ({ url })) } };
}

// Research with Google Search grounding; up to three tries until Gemini actually searched.
async function researchWithGemini({ apiKey, model, prompt }) {
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
  const facts = notes.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()).filter((l) => l.length > 15).map((fact) => ({ fact }));
  return { json: { facts, officialSources: urls.map((url) => ({ url })) } };
}

async function callAI(system, user, maxTokens = 8000) {
  if (OPENROUTER) return (await openrouter({ system, user, maxTokens: Math.max(maxTokens, 16000) })).text;
  if (GEMINI) {
    const json = await geminiGenerate({
      apiKey: process.env.GEMINI_API_KEY,
      model: MODEL,
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: Math.max(maxTokens, 16000) },
      },
    });
    return geminiText(json).trim();
  }
  const msg = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}

const SYSTEM = `You write the blog for fxnholdings.com: FXN Holdings, a digital venture group in Perth, Western Australia, that finds market gaps, then builds and launches e-commerce, travel, content and publishing, price comparison and free online tool platforms on open-source technology.

Voice: plain, confident, specific. Australian English spelling. Short paragraphs. No hype, no clichés ("in today's fast-paced world", "game-changer", "unlock", "delve").

Facts: use ONLY facts stated in the SITE FACTS and RESEARCHED FACTS you are given. Do not invent numbers, dates, clients, partners, revenue, traffic, results, quotes, awards or statistics. If a point needs a number you do not have, make the point without one. Never name a person who works at FXN Holdings.

Return strict JSON only.`;

async function brainstorm(category, count, posts) {
  const existing = posts.map((p) => `- ${p.title}`).join('\n') || '(none)';
  const text = await callAI(SYSTEM, `Suggest ${count} blog post topics for the category "${category.name}" (${category.description}).
Each must be answerable from what FXN Holdings does, useful to partners, suppliers, founders or readers of its platforms, and different from these existing posts:
${existing}

Return {"topics": ["...", ...]} with plain-language working titles.`, 1500);
  return parseAiJson(text, { providerName: argv.provider }).topics?.slice(0, count) || [];
}

async function writePost(topic, category, ctx, feedback = '') {
  const targets = ctx.targets.map((t) => `- ${t.url}  (${t.title})`).join('\n');
  const user = `Write a blog post.

TOPIC: ${topic}
CATEGORY: ${category.name} — ${category.description}
LENGTH: about ${argv.words} words of body text.

SITE FACTS (the only facts you may state about FXN Holdings):
${ctx.facts}
${ctx.researched ? `\nRESEARCHED FACTS from official sources, checked ${ctx.checked} (the only facts you may state about laws, taxes, thresholds and requirements; say where something differs by state or country):\n${ctx.researched}\n\nOFFICIAL SOURCE PAGES (you may link to these, and only these, outside fxnholdings.com):\n${ctx.sources.map((s) => `- ${s.url}`).join('\n')}\n` : ''}
INTERNAL LINK TARGETS (link to at least ${LIMITS.minLinks} of these, only these, with natural descriptive anchor text, never "click here"):
${targets}

RULES
- title: ${argv.title ? `exactly "${argv.title}"` : `at most ${LIMITS.title} characters, the main keyword first, sentence case`}.
- description: the Google snippet, at most ${LIMITS.description} characters, includes the main keyword, ends with a reason to read.
- summary: 1-2 sentences for the post card, at most ${LIMITS.summary} characters.
- body: Markdown only with ## and ### headings, paragraphs, - or 1. lists, > quotes, **bold**, *italic* and [links](/path/). No # heading, no tables, no images, no HTML.
- Use ${LIMITS.minSections}-${LIMITS.maxSections} ## sections. Phrase most ## headings as the question a reader would search. The first paragraph after every ## heading answers it directly in 40-60 words, then the section adds detail.
- Open with a 2-3 sentence introduction (no heading) that states what the post answers.
- End with a short closing section that links to /contact/ or a relevant page.
- image_prompt: a scene for an editorial illustration that matches the post; describe objects and people, not text. image_alt: one sentence describing that illustration, starting "Illustration of".
- inline_images: at least ${argv.images} more illustrations for inside the post, each for a different ## section: after_heading is that section's ## heading text exactly, prompt describes the scene (objects and people, no text, no flags with writing), alt is one sentence starting "Illustration of".
- sources_used: the OFFICIAL SOURCE PAGES (exact URLs) your facts came from; empty list if none were given.
${feedback ? `\nFIX THESE PROBLEMS FROM THE LAST DRAFT:\n${feedback}\n` : ''}
Return {"title": "...", "description": "...", "summary": "...", "body": "...", "image_prompt": "...", "image_alt": "...", "inline_images": [{"after_heading": "...", "prompt": "...", "alt": "..."}], "sources_used": ["..."]}`;
  return parseAiJson(await callAI(SYSTEM, user), { providerName: argv.provider });
}

// OpenRouter (OpenAI-compatible chat API). web: true adds OpenRouter's web search plugin
// and returns the cited URLs from the response annotations.
async function openrouter({ system, user, maxTokens, web = false }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fxnholdings.com',
        'X-Title': 'FXN Holdings post writer',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
        ...(web ? { plugins: [{ id: 'web', max_results: 10 }] } : {}),
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
      continue;
    }
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json.error || json).slice(0, 300)}`);
    const msg = json.choices?.[0]?.message || {};
    const urls = (msg.annotations || []).filter((a) => a.type === 'url_citation').map((a) => a.url_citation?.url).filter(Boolean);
    return { text: String(msg.content || '').trim(), urls: [...new Set(urls)] };
  }
  throw new Error('OpenRouter: gave up after repeated 429/5xx');
}

// --research: official-source facts for guides about the outside world.
// Records about individuals (disqualifications, officers) are never cited
const PERSONAL = /insolvencydirect|\/officers?\/|disqual/i;
const OFFICIAL = /(^|\.)(gov|gov\.uk|gov\.au|govt\.nz|gc\.ca|europa\.eu|gouv\.fr|bund\.de|bundesfinanzministerium\.de|belastingdienst\.nl|revenue\.ie|agenziaentrate\.gov\.it|agenciatributaria\.gob\.es|gob\.es|oecd\.org)$/;
function sourceLabel(url) {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop() || '';
  const words = decodeURIComponent(last).replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').trim();
  const page = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Home page';
  return `${u.hostname.replace(/^www\./, '')}: ${page}`;
}

async function research(topic, category) {
  const today = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Perth', day: 'numeric', month: 'long', year: 'numeric' });
  const research = OPENROUTER ? researchWithOpenRouter : researchWithGemini;
  const { json } = await research({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    prompt: `Research this topic for a practical guide for business owners, many based outside the country concerned: "${topic}" (${category.name}).
Today is ${today}. Use only official government or EU sources (for example gov.uk, irs.gov, state .gov revenue sites, europa.eu, taxation-customs.ec.europa.eu, national tax authorities). Confirm the current requirements, steps, registration thresholds, rates and deadlines that apply now, and note anything that differs by state or country.`,
  });
  const sources = json.officialSources.filter((s) => { try { return OFFICIAL.test(new URL(s.url).hostname) && !PERSONAL.test(s.url); } catch { return false; } })
    .map((s) => ({ ...s, name: sourceLabel(s.url) }));
  const seen = new Set();
  return {
    checked: today,
    facts: json.facts.map((f) => f.fact),
    sources: sources.filter((s) => !seen.has(s.url) && seen.add(s.url)),
  };
}

// Second pass: every factual claim must be supported by SITE FACTS. Returns the
// unsupported ones as [VERIFY] notes; the post is never auto-corrected, so a
// person decides.
async function unsupportedClaims(post, ctx) {
  const text = await callAI('You are a strict fact checker. Return strict JSON only.', `SITE FACTS:
${ctx.facts}

RESEARCHED FACTS:
${ctx.researched || '(none)'}

POST:
${post.title}
${post.body}

List every factual claim in POST (about FXN Holdings, or about laws, taxes, thresholds, registration steps and other requirements) that SITE FACTS and RESEARCHED FACTS do not clearly support. Ignore opinions, general industry knowledge and advice. Quote each claim exactly.
Return {"unsupported": [{"claim": "...", "why": "..."}]} (empty list if all supported).`, 4000);
  const list = parseAiJson(text, { providerName: argv.provider }).unsupported || [];
  return list.map((c) => `claim not on the site: "${oneLine(c.claim)}" (${oneLine(c.why)})`);
}

// ---------------------------------------------------------------- checks

const slugify = (s) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  .slice(0, LIMITS.slug).replace(/-[^-]*$/, (m) => (s.length > LIMITS.slug ? '' : m)).replace(/-+$/, '');
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function audit(post, ctx) {
  const problems = [];
  const verify = [];
  for (const f of ['title', 'description', 'summary', 'body', 'image_prompt', 'image_alt']) if (!post[f]) problems.push(`missing ${f}`);
  if (problems.length) return { problems, verify };
  post.title = argv.title ? oneLine(argv.title) : oneLine(post.title); post.description = oneLine(post.description); post.summary = oneLine(post.summary);
  post.image_prompt = oneLine(post.image_prompt); post.image_alt = oneLine(post.image_alt);
  if (post.title.length > LIMITS.title) problems.push(`title is ${post.title.length} chars; max ${LIMITS.title}`);
  if (post.description.length > LIMITS.description) problems.push(`description is ${post.description.length} chars; max ${LIMITS.description}`);
  if (post.summary.length > LIMITS.summary) problems.push(`summary is ${post.summary.length} chars; max ${LIMITS.summary}`);

  let body = String(post.body).replace(/\r/g, '').trim();
  if (/^# /m.test(body)) body = body.replace(/^# /gm, '## ');
  if (/^\s*\|.*\|\s*$/m.test(body)) problems.push('contains a table; use a list instead');
  if (/!\[[^\]]*\]\(/.test(body)) problems.push('contains an image; remove it');
  if (/<[a-z][^>]*>/i.test(body)) problems.push('contains HTML; use Markdown only');

  // internal links: keep known targets, unlink the rest
  const known = new Set(ctx.targets.map((t) => t.url));
  const unknown = [];
  body = body.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (/^https?:\/\//.test(href) && !href.includes('fxnholdings.com')) {
      if ((ctx.sources || []).some((s) => s.url === href)) return m;
      unknown.push(href);
      return label;
    }
    let url = href.replace(/^https?:\/\/(www\.)?fxnholdings\.com/, '').split('#')[0];
    if (url && !url.endsWith('/')) url += '/';
    if (known.has(url)) return `[${label}](${href.replace(/^https?:\/\/(www\.)?fxnholdings\.com/, '')})`;
    unknown.push(href);
    return label;
  });
  const internal = new Set([...body.matchAll(/\]\((\/[^)\s#]*)/g)].map((m) => m[1]));
  if (internal.size < LIMITS.minLinks) problems.push(`only ${internal.size} distinct internal links; need ${LIMITS.minLinks}`);
  if (unknown.length) console.log(`  unlinked unknown targets: ${unknown.join(', ')}`);

  // sections and answer-first paragraphs
  const sections = body.split(/^## /m).slice(1);
  if (sections.length < LIMITS.minSections || sections.length > LIMITS.maxSections) problems.push(`${sections.length} ## sections; need ${LIMITS.minSections}-${LIMITS.maxSections}`);
  sections.forEach((s) => {
    const [heading, ...rest] = s.split('\n');
    const first = rest.join('\n').trim().split(/\n\s*\n/)[0] || '';
    const words = first.split(/\s+/).filter(Boolean).length;
    if (/^[-*\d>]/.test(first) || words < 30 || words > 75) problems.push(`section "${heading.trim()}" should open with a 40-60 word answer paragraph (has ${words})`);
  });

  // numbers the site does not state
  const factNums = new Set(`${ctx.facts} ${ctx.researched || ''}`.match(/\d[\d,.]*/g) || []);
  const prose = `${post.title} ${post.description} ${post.summary} ${body.replace(/^\s*\d+\.\s/gm, '').replace(/\]\([^)]*\)/g, ']')}`;
  for (const n of new Set(prose.match(/\d[\d,.]*\d|\d/g) || [])) {
    if (!factNums.has(n) && !/^20\d\d$/.test(n)) verify.push(`number "${n}" is not on the site's own pages`);
  }
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < argv.words * 0.8) problems.push(`body is ${words} words; write at least ${Math.ceil(argv.words * 0.8)} (target ${argv.words})`);
  const headings = sections.map((x) => x.split('\n')[0].trim());
  const imgs = (Array.isArray(post.inline_images) ? post.inline_images : [])
    .map((i) => ({ heading: oneLine(i.after_heading).replace(/^#+\s*/, ''), prompt: oneLine(i.prompt), alt: oneLine(i.alt) }))
    .filter((i, k, all) => i.prompt && i.alt && headings.includes(i.heading) && all.findIndex((j) => j.heading === i.heading) === k);
  if (imgs.length < argv.images) problems.push(`need ${argv.images} inline_images on different ## sections, each with after_heading matching a heading exactly (got ${imgs.length} usable)`);
  post.inline_images = imgs;
  post.body = body;
  return { problems, verify };
}

// ---------------------------------------------------------------- output

function toMarkdown(post, category) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' });
  const lines = [
    '---', `title: ${post.title}`, `date: ${today}`, `category: ${category.slug}`,
    `summary: ${post.summary}`, `description: ${post.description}`,
    `image_alt: ${post.image_alt}`, `image_prompt: ${post.image_prompt}`,
    ...post.inline_images.map((img, k) => `image_${k + 2}_prompt: ${img.prompt}`),
    'draft: true', '---', '',
  ];
  return lines.join('\n') + post.body + '\n';
}

function checkBuild() {
  const out = fs.mkdtempSync('/tmp/fxnholdings-check-');
  try {
    execFileSync('python3', [path.join(SITE_DIR, '_src', 'build.py'), '--drafts'], { cwd: SITE_DIR, env: { ...process.env, BUILD_OUT: out }, stdio: 'pipe' });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

async function main() {
  const categories = loadCategories();
  let category = categories.find((c) => c.slug === argv.category || c.name.toLowerCase() === String(argv.category || '').toLowerCase());
  if (argv.category && !category) fatal(`unknown category "${argv.category}"; use one of: ${categories.map((c) => c.slug).join(', ')}`);
  if (!category) {
    const slug = await select({ message: 'Category', choices: categories.map((c) => ({ name: `${c.name} — ${c.description}`, value: c.slug })) });
    category = categories.find((c) => c.slug === slug);
  }
  const posts = loadPosts();
  if (argv.title && argv.title.length > LIMITS.title) fatal(`--title is ${argv.title.length} chars; max ${LIMITS.title}`);
  let topics = argv._.length ? [argv._.join(' ')] : argv.title ? [argv.title] : [];
  if (!topics.length && argv.count === 1 && process.stdin.isTTY) topics = [await input({ message: 'Topic (blank = suggest one)' })].filter(Boolean);
  if (!topics.length) {
    console.log(`brainstorming ${argv.count} topic(s) for ${category.name} ...`);
    topics = await brainstorm(category, argv.count, posts);
  }

  const facts = SOURCE_PAGES.map((n) => { const p = pageText(n); return `## ${p.title}\n${p.text}`; }).join('\n\n')
    + '\n\n## Existing blog posts\n' + posts.filter((p) => !p.draft).map((p) => `- ${p.title}: ${p.summary}`).join('\n');
  const ctx = { facts, targets: linkTargets(posts) };
  const taken = new Set(posts.map((p) => p.slug));

  for (const topic of topics) {
    console.log(`\nwriting: ${topic} (${category.name}, ${MODEL})`);
    let rctx = ctx;
    if (argv.research) {
      console.log(`  researching official sources (${OPENROUTER ? `OpenRouter web search, ${MODEL}` : 'Gemini + Google Search'}) ...`);
      const r = await research(topic, category);
      if (!r.sources.length || !r.facts.length) { console.log('  skipped: no official sources found'); continue; }
      console.log(`  ${r.facts.length} facts from ${r.sources.length} official source(s): ${r.sources.map((x) => x.name).join(', ')}`);
      rctx = { ...ctx, researched: r.facts.map((f) => `- ${f}`).join('\n'), sources: r.sources, checked: r.checked };
    }
    let post; let result; let feedback = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      post = await writePost(topic, category, rctx, feedback);
      result = audit(post, rctx);
      if (!result.problems.length) break;
      console.log(`  attempt ${attempt} failed checks:\n  - ${result.problems.join('\n  - ')}`);
      feedback = result.problems.map((p) => `- ${p}`).join('\n');
    }
    if (result.problems.length) { console.log('  skipped: still failing SEO checks after 3 attempts'); continue; }
    console.log('  fact-checking against the site ...');
    result.verify.push(...await unsupportedClaims(post, rctx));
    if (argv.research) {
      const used = new Set([...(Array.isArray(post.sources_used) ? post.sources_used : []), ...[...post.body.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((x) => x[1])]);
      const cited = rctx.sources.filter((x) => used.has(x.url));
      if (!cited.length) { console.log('  skipped: the post does not rely on any official source'); continue; }
      post.body += `\n\n---\n\n**Official sources** (checked ${rctx.checked})\n\n${cited.map((x) => `- [${x.name}](${x.url})`).join('\n')}\n\n*This guide is general information, not legal or tax advice. Rules change and can differ by state or country, so confirm with the official source or a qualified adviser before you act.*`;
    }

    let slug = slugify(post.title);
    for (let i = 2; taken.has(slug); i += 1) slug = `${slugify(post.title).slice(0, LIMITS.slug - 3)}-${i}`;
    post.inline_images.forEach((img, k) => {
      // after the section's opening answer, so the answer stays first
      const re = new RegExp(`(^## ${img.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n+[^\n]+(?:\n[^\n]+)*)`, 'm');
      post.body = post.body.replace(re, `$1\n\n![${img.alt.replace(/[[\]]/g, '')}](/img/insights/${slug}-${k + 2}.webp)`);
    });
    const md = toMarkdown(post, category);
    const notes = result.verify.length ? `[VERIFY] before publishing ${slug}.md:\n${result.verify.map((v) => `- ${v}`).join('\n')}\n` : '';
    const words = post.body.split(/\s+/).length;
    console.log(`  ok: "${post.title}" (${post.title.length + SUFFIX.length}-char title tag, ${post.description.length}-char description, ${words} words)`);
    if (argv['dry-run']) { console.log(`\n--- ${slug}.md ---\n${md}\n${notes}`); continue; }

    const file = path.join(POSTS_DIR, `${slug}.md`);
    fs.writeFileSync(file, md);
    taken.add(slug);
    if (argv.image) {
      console.log(`  generating ${1 + post.inline_images.length} images with fal.ai ...`);
      execFileSync('python3', [path.join(SITE_DIR, '_src', 'featured_images.py'), slug], { cwd: SITE_DIR, stdio: 'inherit' });
    } else {
      console.log(`  images not generated (--no-image); run: python3 _src/featured_images.py ${slug}`);
    }
    if (argv.image) try {
      checkBuild();
    } catch (err) {
      fs.renameSync(file, `${file}.rejected`);
      console.log(`  site build rejected the post, kept as ${file}.rejected:\n${String(err.stderr || err.message).trim()}`);
      continue;
    }
    console.log(`  wrote ${file} (draft)`);
    const notesFile = path.join(POSTS_DIR, `${slug}.verify.txt`);
    if (notes) {
      fs.writeFileSync(notesFile, notes);
      console.log(`  [VERIFY] ${result.verify.length} item(s) to check: ${notesFile}`);
    }
    console.log(`  preview: ${PREVIEW}/insights/${slug}/`);
  }
}

main().catch((err) => fatal(err.message));
