/**
 * Convert bls-post content that was stored as Markdown into HTML.
 *
 *   node markdown-to-html.mjs                 # dry run
 *   node markdown-to-html.mjs --write
 *   node markdown-to-html.mjs --write --slugs=a,b
 *
 * bls-post.content is rendered with dangerouslySetInnerHTML, so Markdown shows
 * on the page as literal "##" and "**". The generator defaulted this site to
 * Markdown while all 120 pre-existing posts were HTML; the default is fixed, and
 * this repairs what was already written.
 *
 * Two shapes are handled. Most posts hold real newlines. One holds the
 * two-character sequence \n instead -- escaped once too often on the way in --
 * which leaves the whole article as a single line that no Markdown parser can
 * do anything with, so those are unescaped before conversion.
 *
 * Only content that still looks like Markdown is touched. Anything already
 * carrying block-level HTML is left exactly as it is, so a re-run is a no-op and
 * the pre-existing HTML posts are never rewritten.
 */
import 'dotenv/config';
import { marked } from 'marked';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ONLY = (args.find((a) => a.startsWith('--slugs=')) || '').split('=')[1];
const ONLY_SET = ONLY ? new Set(ONLY.split(',').map((x) => x.trim()).filter(Boolean)) : null;

const STRAPI = (process.env.STRAPI_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = process.env.STRAPI_API_TOKEN;

async function api(path, init = {}) {
  const res = await fetch(`${STRAPI}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}

/** Block-level HTML means it has already been converted (or was always HTML). */
const looksHtml = (c) => /<(p|h2|h3|ul|ol|figure|table|div)\b/i.test(c);
/** Markdown headings, bold, or list bullets at line start. */
const looksMarkdown = (c) => /(^|\n)#{2,3}\s/.test(c) || /(^|\n)[-*]\s/.test(c) || /\*\*[^*]+\*\*/.test(c);

async function collect(status) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const d = await api(`/api/bls-posts?status=${status}&pagination[page]=${page}&pagination[pageSize]=100&fields[0]=slug&fields[1]=content`);
    out.push(...(d.data ?? []));
    if (page >= (d.meta?.pagination?.pageCount ?? 1)) break;
  }
  return out;
}

for (const status of ['draft', 'published']) {
  const posts = await collect(status);
  let converted = 0, skipped = 0;
  for (const post of posts) {
    if (ONLY_SET && !ONLY_SET.has(post.slug)) continue;
    let content = post.content || '';
    if (!content) { continue; }

    // Unescape a body that was stored with literal \n instead of newlines.
    const escaped = !content.includes('\n') && content.includes('\\n');
    if (escaped) content = content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');

    if (looksHtml(content) || !looksMarkdown(content)) { skipped += 1; continue; }

    const html = marked.parse(content, { mangle: false, headerIds: false }).trim();
    console.log(`  [${status}] ${post.slug}${escaped ? '  (unescaped newlines)' : ''}  ${content.length} md -> ${html.length} html`);
    if (WRITE) {
      // status in the query so a draft stays a draft and a published post stays published
      await api(`/api/bls-posts/${post.documentId}?status=${status}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { content: html } }),
      });
    }
    converted += 1;
  }
  console.log(`  ${status}: ${WRITE ? 'converted' : 'would convert'} ${converted}, left alone ${skipped}\n`);
}
console.log(WRITE ? 'done.' : 'dry run -- nothing written.');
