'use strict';

/**
 * Keyword research for one site.
 *
 * Nothing here does the research. The work is the existing `keyword-research`
 * job on the host runner, which pulls real search volume, competition and CPC
 * from DataForSEO and then asks the model only for relevance, intent and a
 * content suggestion. That split is the point of the feature, and it is
 * preserved rather than reimplemented: the model is never asked to estimate a
 * number it cannot know.
 *
 * This service starts that job for a given site, waits for it, and parses the
 * structured block back out of the run log.
 */

const RUNNER_URL = (process.env.RUNNER_URL || 'http://172.18.0.1:4310').replace(/\/$/, '');
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';
const SITE_UID = 'api::commerce-site.commerce-site';

async function runner(path, init = {}) {
  const res = await fetch(`${RUNNER_URL}${path}`, {
    ...init,
    headers: {
      ...(RUNNER_TOKEN ? { Authorization: `Bearer ${RUNNER_TOKEN}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `runner returned ${res.status}`);
  return body;
}

/**
 * The script prints a table for humans and a JSON object under --json. Taking
 * the last balanced {...} block is deliberate: the log also carries progress
 * lines, and a naive first-brace match would grab one of those.
 */
function parseResult(log) {
  const start = log.indexOf('{');
  if (start === -1) return null;
  for (let end = log.lastIndexOf('}'); end > start; end = log.lastIndexOf('}', end - 1)) {
    try {
      const parsed = JSON.parse(log.slice(start, end + 1));
      if (parsed && Array.isArray(parsed.keywords)) return parsed;
    } catch {
      /* keep walking back to the previous closing brace */
    }
  }
  return null;
}

module.exports = ({ strapi }) => ({
  async research(slug, { seed, count = 20, longtail = false, location } = {}) {
    if (!seed || !String(seed).trim()) return { error: 'A seed keyword is required.' };

    const [site] = await strapi.documents(SITE_UID).findMany({
      filters: { slug },
      status: 'draft',
      limit: 1,
    });
    if (!site) return { error: `No site with slug "${slug}".` };

    let started;
    try {
      started = await runner('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          jobId: 'keyword-research',
          // DataForSEO is billed per search, so this only runs when a person asks.
          write: true,
          values: {
            seed: String(seed).trim(),
            count: String(count),
            longtail: Boolean(longtail),
            site: site.domain,
            // The site's own brief is the best short description of who this is for.
            instructions: (site.aiWriterBrief || '').slice(0, 600) || undefined,
            location: String(location || (site.country === 'AU' ? 2036 : 2036)),
            json: true,
          },
        }),
      });
    } catch (error) {
      return { error: `Could not reach the job runner: ${error.message}` };
    }

    const runId = started?.run?.id ?? started?.id;
    if (!runId) return { error: 'The runner accepted the job but returned no run id.' };
    return { runId, site: { slug: site.slug, name: site.name, domain: site.domain } };
  },

  /** Poll: the admin asks for this until status is no longer "running". */
  async result(runId) {
    let detail;
    try {
      detail = await runner(`/api/runs/${runId}`);
    } catch (error) {
      return { error: error.message };
    }

    const run = detail?.run ?? detail;
    const status = run?.status ?? 'unknown';
    if (status === 'running') return { status };

    let log = '';
    try {
      const logBody = await runner(`/api/runs/${runId}/log?offset=0`);
      log = logBody?.text ?? logBody?.chunk ?? logBody?.log ?? '';
    } catch {
      /* fall through — reported below as no parsable result */
    }

    const parsed = parseResult(log);
    if (!parsed) {
      return {
        status,
        error:
          status === 'failed'
            ? `The research job failed. ${log.trim().split('\n').slice(-3).join(' ') || ''}`.trim()
            : 'The job finished but produced no readable result.',
      };
    }

    return { status, ...parsed };
  },
});
