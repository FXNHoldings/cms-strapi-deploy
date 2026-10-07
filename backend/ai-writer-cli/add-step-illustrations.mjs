#!/usr/bin/env node
/**
 * Add an illustration under each "### Step N: ..." heading of a draft
 * nxtsmarthome.com.au how-to guide.
 *
 *   node add-step-illustrations.mjs <slug> [<slug> ...]            preview prompts, change nothing
 *   node add-step-illustrations.mjs <slug> [<slug> ...] --write    generate, upload, insert (draft only)
 *
 * The site never claims hands-on testing (projects/nxtsmarthome.com.au/CLAUDE.md
 * rule 5), so these are labelled illustrations, not photos of us doing the step:
 * no app screens, no on-screen text, no brand logos, nothing that could pass as
 * a real screenshot. Real screenshots belong to the manufacturer's own setup
 * guide, which the article links in its Sources.
 *
 * Prompts come from Gemini (GEMINI_API_KEY), images from fal.ai FLUX dev
 * (FAL_KEY, ~US$0.025 each). Works on the draft version only; publishing stays
 * a separate, reviewed step. A step that already has an image is skipped.
 */
import 'dotenv/config';
import { fal } from '@fal-ai/client';
import { geminiGenerate, geminiText } from './nxtsmarthome-content-rules.js';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const slugs = args.filter((a) => !a.startsWith('--'));
// --redo=3,4 replaces the images under those step numbers.
// --briefs=file.json: hand-written {"<step number>": {"brief": "...", "alt": "..."}} that override Gemini's.
const BRIEFS_FILE = (args.find((a) => a.startsWith('--briefs=')) || '').slice(9);
const REDO = new Set((args.find((a) => a.startsWith('--redo=')) || '').slice(7).split(',').filter(Boolean).map(Number));
const { STRAPI_URL, STRAPI_API_TOKEN, GEMINI_API_KEY, FAL_KEY } = process.env;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MEDIA_BASE = (process.env.STRAPI_PUBLIC_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
const H = { Authorization: `Bearer ${STRAPI_API_TOKEN}` };
const POSTS = `${STRAPI_URL}/api/nxtsmarthome-posts`;
if (!slugs.length) {
  console.error('usage: node add-step-illustrations.mjs <slug> [...] [--write]');
  process.exit(1);
}
if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const STYLE =
  'Photorealistic editorial photograph in an Australian home, natural window light, shallow depth of field, ' +
  'warm neutral tones. No readable text, no app screens or phone UI (a phone, if shown, is face-down or its ' +
  'screen is out of focus), no brand names or logos (including on the back of a phone), no faces or people ' +
  'beyond hands and forearms. Light comes only from bulbs and lamps, never from inside a wall switch. ' +
  'Australian flat-plate wall switches where they appear. Image models draw Australian power points and plug ' +
  'pins wrongly (American sockets), so never show a socket face or plug pins up close: keep any power point ' +
  'small, side-on and out of focus, and show a smart plug from above or the side, its pins hidden.';

async function briefs(title, steps) {
  const res = await geminiGenerate({
    apiKey: GEMINI_API_KEY,
    model: GEMINI_MODEL,
    body: {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `For the how-to guide "${title}", write one image brief per step: what the camera sees while someone does that step (hands, the device, the setting). 25-40 words each. Never describe on-screen text, an app screen, a logo or a brand. Also give short alt text (under 15 words) describing the image.\n\n${steps
                .map((s, i) => `Step ${i + 1}: ${s.heading}\n${s.body.slice(0, 600)}`)
                .join('\n\n')}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: { brief: { type: 'STRING' }, alt: { type: 'STRING' } }, required: ['brief', 'alt'] },
        },
      },
    },
  });
  return JSON.parse(geminiText(res));
}

async function upload(imageUrl, name) {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`download ${img.status}`);
  const form = new FormData();
  form.append('files', new Blob([await img.arrayBuffer()], { type: img.headers.get('content-type') || 'image/jpeg' }), `${name}.jpg`);
  const res = await fetch(`${STRAPI_URL}/api/upload`, { method: 'POST', headers: H, body: form });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const [file] = await res.json();
  return file.url.startsWith('http') ? file.url : `${MEDIA_BASE}${file.url}`;
}

for (const slug of slugs) {
  const doc = (await (await fetch(`${POSTS}?filters[slug][$eq]=${slug}&status=draft`, { headers: H })).json()).data?.[0];
  if (!doc) {
    console.log(`${slug}: no draft found`);
    continue;
  }
  const content = String(doc.content);
  const re = /^### (Step \d+[:.][^\n]*)\n([\s\S]*?)(?=^#{2,3} |\s*$(?![\s\S]))/gm;
  let steps = [...content.matchAll(re)].map((m) => ({ heading: m[1].trim(), body: m[2], raw: m[0] }));
  let base = content;
  for (const s of steps) {
    const n = Number(s.heading.match(/\d+/)[0]);
    if (REDO.has(n)) base = base.replace(s.raw, s.raw.replace(/^(### [^\n]*\n)\n!\[[^\n]*\n\n\*Illustration\*\n\n/, '$1'));
  }
  steps = [...base.matchAll(re)].map((m) => ({ heading: m[1].trim(), body: m[2], raw: m[0] }));
  const todo = steps.filter((s) => !/^\s*!\[/.test(s.body));
  console.log(`\n${slug}: ${steps.length} steps, ${todo.length} without an image`);
  if (!todo.length) continue;
  const own = BRIEFS_FILE ? JSON.parse((await import('node:fs')).readFileSync(BRIEFS_FILE, 'utf8')) : {};
  const missing = todo.filter((s) => !own[s.heading.match(/\d+/)[0]]);
  const fromGemini = missing.length ? await briefs(doc.title, missing) : [];
  const b = todo.map((s) => own[s.heading.match(/\d+/)[0]] ?? fromGemini[missing.indexOf(s)]);
  let next = base;
  for (const [i, step] of todo.entries()) {
    const { brief, alt } = b[i] ?? {};
    if (!brief) continue;
    console.log(`  ${step.heading}\n    ${brief}`);
    if (!WRITE) continue;
    const r = await fal.subscribe('fal-ai/flux/dev', {
      input: { prompt: `${brief} ${STYLE}`, image_size: 'landscape_16_9', num_images: 1 },
    });
    const url = await upload(r.data.images[0].url, `${slug}-step-${step.heading.match(/\d+/)[0]}`);
    const figure = `![${alt.replace(/[[\]]/g, '')}](${url})\n\n*Illustration*\n\n`;
    next = next.replace(`### ${step.heading}\n`, `### ${step.heading}\n\n${figure}`);
    console.log(`    -> ${url}`);
  }
  if (WRITE && next !== content) {
    const res = await fetch(`${POSTS}/${doc.documentId}?status=draft`, {
      method: 'PUT',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { content: next } }),
    });
    console.log(`  saved draft: ${res.status}`);
  }
}
