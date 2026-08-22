/**
 * The one place these scripts talk to Claude.
 *
 * Every caller wants the same thing — a prompt in, a known-shaped JSON object
 * out — so the shape is enforced by the API rather than by each script fishing
 * a `{...}` out of prose with a regex. `output_config.format` constrains the
 * response to the schema, which removes a whole class of "the model wrapped it
 * in a markdown fence" failure that the old chat-completions path hit.
 *
 * Two things deliberately absent:
 *
 *   No `temperature`. The current models reject it outright with a 400 — it is
 *   not merely ignored — so the old per-script PRODUCT_*_TEMPERATURE knobs
 *   could not be carried across. Steer these prompts with wording instead.
 *
 *   No provider fallback. This module is Anthropic only; scripts that keep an
 *   OpenClaw or OpenAI path decide between them themselves.
 */

import Anthropic from '@anthropic-ai/sdk';

/* Opus by default: these run in bulk over the catalogue, unattended, and a
   wrong title is written to production. Override per script when a cheaper
   model measures out well on that particular job. */
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;

let client = null;

export function anthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * First model named by any of `envNames` that is actually set, else the default.
 * Lets each script keep its own override without every script inventing one.
 */
export function anthropicModel(...envNames) {
  for (const name of envNames) {
    const value = String(process.env[name] ?? '').trim();
    if (value) return value;
  }
  return String(process.env.ANTHROPIC_MODEL ?? '').trim() || DEFAULT_MODEL;
}

function getClient() {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    });
  }
  return client;
}

/**
 * Ask Claude for one JSON object matching `schema`.
 *
 * Throws with the real reason rather than a generic failure — an out-of-credit
 * account, a bad key and a malformed schema each produce a different message,
 * because conflating them once already made a billing problem look like a
 * configuration mistake and cost an afternoon.
 */
export async function askForJson({
  system,
  prompt,
  schema,
  model,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (!anthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local.');
  }

  let message;
  try {
    message = await getClient().messages.create({
      model: model || anthropicModel(),
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema } },
    });
  } catch (error) {
    // status is present on every APIError; absent means the request never landed.
    const status = error?.status;
    if (status === 401) throw new Error('Anthropic rejected the API key (401).');
    if (status === 400) throw new Error(`Anthropic rejected the request (400): ${error.message}`);
    if (status === 429) throw new Error('Anthropic rate limit reached (429), after the SDK retried.');
    if (status >= 500) throw new Error(`Anthropic is unavailable (${status}), after the SDK retried.`);
    throw new Error(`Anthropic request failed: ${error?.message ?? error}`);
  }

  /* A refusal is an HTTP 200 with no usable content, so it has to be checked
     before reading the blocks rather than after they come back empty. */
  if (message.stop_reason === 'refusal') {
    throw new Error(
      `Anthropic declined this request (${message.stop_details?.category ?? 'no category given'}).`,
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Response hit max_tokens (${maxTokens}) and is truncated — raise it for this job.`);
  }

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('Anthropic returned an empty response.');

  try {
    return JSON.parse(text);
  } catch (error) {
    // Should not happen under output_config.format, so say so loudly if it does.
    throw new Error(`Schema-constrained output did not parse as JSON: ${error.message}`);
  }
}
