import 'dotenv/config';
import { fal } from '@fal-ai/client';

const { STRAPI_URL = 'http://127.0.0.1:8888', STRAPI_API_TOKEN, FAL_KEY } = process.env;
if (!FAL_KEY) { console.error('FAL_KEY not set'); process.exit(1); }
fal.config({ credentials: FAL_KEY });

const COVERS = [
  ['smart-home-guide', 'A cozy modern living room set up as a smart home at golden hour, warm ambient lighting, a few tasteful connected devices (smart speaker, smart bulbs) subtly visible, wide cinematic photorealistic interior. No text, no logos, no people faces.'],
  ['matter-thread-guide', 'Clean abstract visualization of connected smart-home devices linked by glowing teal and blue light lines, minimal modern tech aesthetic, soft depth of field, wide cinematic. No text, no logos.'],
  ['best-smart-home-hub', 'A smart home hub and voice-assistant speakers arranged on a wooden shelf in a bright modern living room, soft daylight, shallow depth of field, wide cinematic photorealistic. No text, no logos.'],
  ['best-smart-security-camera', 'A modern smart security camera and video doorbell mounted by a front door of a contemporary home, clear daylight, crisp detail, wide cinematic photorealistic. No text, no logos.'],
  ['smart-home-energy-guide', 'A sleek smart thermostat on the wall of a bright, energy-efficient modern home, soft natural light, warm neutral tones, wide cinematic photorealistic. No text, no logos.'],
  ['best-robot-vacuum', 'A robot vacuum cleaning the floor of a tidy modern living room, warm afternoon light, motion sense of cleanliness, wide cinematic photorealistic. No text, no logos.'],
];

async function strapi(path, init = {}) {
  const r = await fetch(`${STRAPI_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}`, ...(init.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { status: r.status, j, t };
}

for (const [slug, prompt] of COVERS) {
  process.stdout.write(`▸ ${slug} … `);
  const found = (await strapi(`/api/gatsby-posts?filters[slug][$eq]=${slug}&populate=coverImage&pagination[pageSize]=1`)).j?.data?.[0];
  if (!found) { console.log('post not found'); continue; }
  if (found.coverImage) { console.log('already has a cover — skipping'); continue; }
  try {
    const res = await fal.subscribe('fal-ai/flux/schnell', { input: { prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true }, logs: false });
    const url = res?.data?.images?.[0]?.url;
    if (!url) { console.log('no image url'); continue; }
    const img = await fetch(url); const ab = await img.arrayBuffer();
    const ct = img.headers.get('content-type') || 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const form = new FormData();
    form.append('files', new Blob([ab], { type: ct }), `${slug}-cover.${ext}`);
    const up = await fetch(`${STRAPI_URL}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${STRAPI_API_TOKEN}` }, body: form });
    const uploaded = await up.json(); const media = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!media?.id) { console.log('upload failed'); continue; }
    const put = await strapi(`/api/gatsby-posts/${found.documentId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { coverImage: media.id } }) });
    console.log(put.status < 300 ? `cover set (media #${media.id})` : `PUT failed ${put.status}`);
  } catch (e) { console.log('error: ' + e.message); }
}
console.log('\nDone.');
