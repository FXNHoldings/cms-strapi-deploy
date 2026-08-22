/* eslint-disable no-console */
'use strict';

/**
 * Fire any content populator that is due. Meant for cron, every 15 minutes.
 *
 *   node ./scripts/tick-populators.mjs --dry-run
 *   node ./scripts/tick-populators.mjs
 *
 * A populator is a standing rule — write for this site, using this generator,
 * about these topics, this often. The generators already exist on the job
 * runner and are unchanged; this only decides what to call and when.
 *
 * Three properties make an unattended writer safe to leave running:
 *
 *   Drafts by default. publishMode has to be set to "publish" deliberately.
 *     Unattended publishing is how a site fills with content nobody read.
 *
 *   The ceiling is enforced here, not by the cadence. maxPerWeek is checked
 *     against a rolling window at dispatch time, so a mistyped cadence costs a
 *     quiet week rather than two hundred posts. Belt and braces, because the
 *     cadence is the thing a human edits.
 *
 *   Topics are consumed, never invented. Each run takes one from the front of
 *     topicQueue and moves it to topicsUsed. An empty queue means the populator
 *     idles — it does not make something up, and it does not repeat itself.
 *
 * Failure to reach the runner is not recorded as a run: lastRunAt and the
 * counter only move once the runner has accepted the job, so a runner that is
 * down delays the schedule instead of silently eating a slot.
 */

import { createRequire } from 'module';

process.env.STRAPI_SKIP_POLLERS = '1';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

const UID = 'api::content-populator.content-populator';
const RUNNER_URL = (process.env.RUNNER_URL || 'http://172.17.0.1:4310').replace(/\/$/, '');
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const DRY_RUN = process.argv.includes('--dry-run');

function isDue(p, now) {
  if (!p.enabled) return false;
  if (!p.lastRunAt) return true;
  const gap = now - new Date(p.lastRunAt).getTime();
  return gap >= Math.max(1, p.cadenceHours ?? 168) * 3600_000;
}

/** Rolling seven days, reset when the window has aged out. */
function windowState(p, now) {
  const start = p.runWindowStart ? new Date(p.runWindowStart).getTime() : 0;
  if (!start || now - start >= WEEK_MS) {
    return { runsThisWeek: 0, runWindowStart: new Date(now).toISOString(), reset: true };
  }
  return { runsThisWeek: p.runsThisWeek ?? 0, runWindowStart: p.runWindowStart, reset: false };
}

async function startRun(jobId, values) {
  const res = await fetch(`${RUNNER_URL}/api/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(RUNNER_TOKEN ? { Authorization: `Bearer ${RUNNER_TOKEN}` } : {}),
    },
    body: JSON.stringify({ jobId, values, write: true }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `runner returned ${res.status}`);
  return body;
}

async function main() {
  const strapi = await createStrapi().load();
  strapi.log.level = 'error';
  const now = Date.now();

  try {
    const populators = await strapi.documents(UID).findMany({ populate: { site: true }, limit: 200 });
    const due = populators.filter((p) => isDue(p, now));

    console.log(`${populators.length} populator(s), ${populators.filter((p) => p.enabled).length} enabled, ${due.length} due${DRY_RUN ? ' (dry run)' : ''}`);

    for (const p of due) {
      const win = windowState(p, now);

      if (win.runsThisWeek >= (p.maxPerWeek ?? 3)) {
        console.log(`  ceiling  ${p.name} — ${win.runsThisWeek}/${p.maxPerWeek} this week, skipping`);
        continue;
      }

      const queue = Array.isArray(p.topicQueue) ? [...p.topicQueue] : [];
      if (!queue.length) {
        console.log(`  idle     ${p.name} — topic queue empty, nothing commissioned`);
        continue;
      }

      const topic = queue.shift();
      const values = {
        ...(p.jobParams && typeof p.jobParams === 'object' ? p.jobParams : {}),
        topics: topic,
        count: 1,
        ...(p.publishMode === 'publish' ? { publish: true } : {}),
      };

      console.log(`  run      ${p.name} — ${p.jobId} · "${String(topic).slice(0, 46)}" · ${p.publishMode}`);
      if (DRY_RUN) continue;

      let run;
      try {
        run = await startRun(p.jobId, values);
      } catch (error) {
        // Not counted as a run: the schedule slips rather than losing a slot.
        console.error(`  ! ${p.name}: ${error.message}`);
        await strapi.documents(UID).update({
          documentId: p.documentId,
          data: { lastRunStatus: `could not start: ${error.message}`.slice(0, 200) },
        });
        continue;
      }

      await strapi.documents(UID).update({
        documentId: p.documentId,
        data: {
          topicQueue: queue,
          topicsUsed: [...(Array.isArray(p.topicsUsed) ? p.topicsUsed : []), topic],
          lastRunAt: new Date(now).toISOString(),
          lastRunId: String(run.id ?? run.runId ?? ''),
          lastRunStatus: 'started',
          runsThisWeek: win.runsThisWeek + 1,
          runWindowStart: win.runWindowStart,
        },
      });
    }
  } finally {
    await strapi.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
