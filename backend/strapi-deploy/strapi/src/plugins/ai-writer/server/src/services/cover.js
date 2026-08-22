'use strict';

/**
 * Generate a cover image for a post being written.
 *
 * src/ai-images.js already does this, but only for api::article.article and
 * only through a poller triggered by a Content Manager save. AI Writer needs it
 * for whichever collection the site owns, while the person is standing there
 * waiting — so the same two steps (Claude writes the prompt, fal renders it,
 * Strapi stores it) run inline here rather than being queued.
 *
 * The prompt step is not decoration: asked for an image directly from a
 * headline, the model returns a literal illustration of the words. Asked for a
 * photographic brief first, it returns something that looks like editorial
 * photography.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const slugify = require('slugify');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

/* The site's covers are all 1536x768. Generators do not offer that ratio — it
   is 2:1 and the closest Ultra accepts is 16:9 — so the image is rendered wide
   and then cropped to size here. Doing it at upload time means every cover is
   the right shape whatever model produced it. */
const COVER_W = 1536;
const COVER_H = 768;

function cfg(strapi, key, fallback = '') {
  return strapi.config.get(`plugin::ai-writer.${key}`) ?? fallback;
}

const PROMPT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false,
};

/**
 * fal's image models do not share an input shape.
 *
 * flux/schnell and flux-pro/v1.1 take image_size with a named preset
 * ("landscape_16_9"). flux-pro/v1.1-ultra takes aspect_ratio as a ratio string
 * ("16:9") and ignores image_size — so simply pointing FAL_IMAGE_MODEL at Ultra
 * without this would silently produce square covers.
 */
function falInput(model, prompt) {
  const base = { prompt, num_images: 1, enable_safety_checker: true };
  if (/ultra/.test(model)) return { ...base, aspect_ratio: '16:9', output_format: 'jpeg' };
  return { ...base, image_size: 'landscape_16_9' };
}

async function uploadUrlToStrapi(strapi, url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the generated image: HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());

  /* Centre-crop rather than squash: Ultra renders 2752x1536, and scaling that
     to 2:1 would distort every face and product in it. */
  const buf = await sharp(raw)
    .resize(COVER_W, COVER_H, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 88 })
    .toBuffer();
  const mime = 'image/jpeg';
  const ext = 'jpg';

  const tmp = path.join(os.tmpdir(), `${filename}-${Date.now()}.${ext}`);
  fs.writeFileSync(tmp, buf);
  const stats = fs.statSync(tmp);
  try {
    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: {},
      files: { filepath: tmp, originalFilename: `${filename}.${ext}`, mimetype: mime, size: stats.size },
    });
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!file?.id) throw new Error('Strapi stored the image but returned no id');
    return file;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

module.exports = ({ strapi }) => ({
  async generate({ title, brief, excerpt }) {
    const FAL_KEY = process.env.FAL_KEY;
    if (!FAL_KEY) return { error: 'FAL_KEY is not set on the Strapi server, so images cannot be generated.' };

    const apiKey = cfg(strapi, 'anthropicApiKey');
    if (!apiKey) return { error: 'ANTHROPIC_API_KEY is not configured.' };

    let prompt;
    try {
      const client = new Anthropic({ apiKey });
      const message = await client.messages.create({
        model: cfg(strapi, 'model', 'claude-opus-5'),
        /* 500 truncated the brief mid-string and the JSON would not parse.
           A photographic brief is a paragraph, not a sentence. */
        max_tokens: 1500,
        system:
          'You write briefs for editorial photography. Return one prompt for a photorealistic ' +
          'image suitable as the header of the article described. Describe a scene, its lighting ' +
          'and framing. Never ask for text, words, letters, numbers, logos or brand names in the ' +
          'image — models render them wrong and a misspelt word baked into a cover is permanent.',
        messages: [{
          role: 'user',
          content: [
            brief ? `Publication brief:\n${brief}\n` : '',
            `Article title: ${title}`,
            excerpt ? `Summary: ${excerpt}` : '',
          ].filter(Boolean).join('\n'),
        }],
        output_config: { format: { type: 'json_schema', schema: PROMPT_SCHEMA } },
      });

      if (message.stop_reason === 'refusal') {
        return { error: 'Anthropic declined to write an image prompt for this title.' };
      }
      /* Caught explicitly: a truncated response fails as a JSON parse error,
         which reads like a bug rather than a ceiling that needs raising. */
      if (message.stop_reason === 'max_tokens') {
        return { error: 'The image prompt hit its token ceiling and came back truncated.' };
      }
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      prompt = JSON.parse(text).prompt;
    } catch (error) {
      return { error: `Could not write the image prompt: ${error.message}` };
    }

    try {
      const { fal } = await import('@fal-ai/client');
      fal.config({ credentials: FAL_KEY });
      const model = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';

      const res = await fal.subscribe(model, { input: falInput(model, prompt), logs: false });
      const url = res?.data?.images?.[0]?.url;
      if (!url) return { error: 'The image service returned no image.' };

      const base = slugify(title || 'cover', { lower: true, strict: true }).slice(0, 50);
      const file = await uploadUrlToStrapi(strapi, url, `${base}-cover`);
      return { file: { id: file.id, url: file.url, name: file.name }, prompt };
    } catch (error) {
      return { error: `Image generation failed: ${error.message}` };
    }
  },
});
