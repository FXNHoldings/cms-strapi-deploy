'use strict';
const Anthropic = require('@anthropic-ai/sdk');

module.exports = ({ strapi }) => ({
  async generate(params) {
    const apiKey = strapi.config.get('plugin::ai-writer.anthropicApiKey');
    const model = strapi.config.get('plugin::ai-writer.model') || 'claude-sonnet-4-5-20250929';
    const maxTokens = strapi.config.get('plugin::ai-writer.maxTokens') || 4096;

    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured. Set it in .env.');
    }

    const client = new Anthropic.default({ apiKey });

    const lengthMap = { short: '400-600', medium: '800-1200', long: '1500-2200' };
    const words = lengthMap[params.length || 'medium'];

    const systemPrompt = `You are a senior travel journalist writing for a travel blog (flights, hotels, destinations, tips).
Output MUST be strict JSON matching this TypeScript type:
{
  "title": string,
  "slug": string,
  "excerpt": string,
  "content": string,
  "seoTitle": string,
  "seoDescription": string,
  "seoKeywords": string,
  "tags": string[],
  "readingTimeMinutes": number
}
Do not include any text outside the JSON. Do not wrap it in markdown fences.`;

    const userPrompt = [
      `Topic: ${params.topic}`,
      params.destination ? `Destination: ${params.destination}` : '',
      params.category ? `Category: ${params.category}` : '',
      params.tone ? `Tone: ${params.tone}` : 'Tone: friendly, informative, trustworthy',
      params.keywords && params.keywords.length ? `Keywords to include: ${params.keywords.join(', ')}` : '',
      params.language ? `Language: ${params.language}` : 'Language: English',
      `Target length: ${words} words`,
    ].filter(Boolean).join('\n');

    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const parsed = safeParse(text);
    if (!parsed) throw new Error('Claude returned non-JSON output: ' + text.slice(0, 300));
    return parsed;
  },
});

function safeParse(s) {
  try { return JSON.parse(s); }
  catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}
