'use strict';

/**
 * Thin proxy to the host job runner.
 *
 * The runner is bound to 127.0.0.1 and holds the DataForSEO credentials and the
 * scripts. Strapi talks to it server-side so the runner token never reaches a
 * browser, and so the admin session is what authorises a run.
 *
 * Note the host: Strapi runs in a container, so "localhost" is the container,
 * not the machine. RUNNER_URL must point at the host gateway.
 */
const RUNNER_URL = (process.env.RUNNER_URL || 'http://172.17.0.1:4310').replace(/\/$/, '');
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';

async function call(ctx, path, init = {}) {
  try {
    const res = await fetch(`${RUNNER_URL}${path}`, {
      ...init,
      headers: {
        ...(RUNNER_TOKEN ? { Authorization: `Bearer ${RUNNER_TOKEN}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    ctx.status = res.status;
    ctx.body = body;
  } catch (e) {
    ctx.status = 502;
    ctx.body = {
      error: `Cannot reach the job runner at ${RUNNER_URL}. Is nxt-job-runner running? (${e.message})`,
    };
  }
}

module.exports = {
  async catalogue(ctx) { await call(ctx, '/api/jobs'); },
  async history(ctx) { await call(ctx, '/api/runs'); },
  async detail(ctx) { await call(ctx, `/api/runs/${ctx.params.id}`); },
  async log(ctx) {
    const offset = Number(ctx.query.offset || 0);
    await call(ctx, `/api/runs/${ctx.params.id}/log?offset=${offset}`);
  },
  async cancel(ctx) { await call(ctx, `/api/runs/${ctx.params.id}/cancel`, { method: 'POST' }); },
  async start(ctx) {
    await call(ctx, '/api/runs', { method: 'POST', body: JSON.stringify(ctx.request.body || {}) });
  },
};
