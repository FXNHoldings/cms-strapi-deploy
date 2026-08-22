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
 * Accepting a job is not the same as doing it. The runner returns as soon as it
 * has spawned the child, minutes before the generator finishes, so "the runner
 * took it" says nothing about whether a post exists at the end. An earlier
 * version committed the topic and the weekly slot at that moment and never
 * looked again, which made a failed generation indistinguishable from a
 * successful one: topics drained, the ceiling filled, nothing got written.
 *
 * So each tick reconciles before it dispatches. A populator whose last run is
 * still marked "started" is looked up on the runner first:
 *
 *   still running  leave it alone and skip it this tick, so one populator never
 *                  has two generators going at once.
 *   succeeded      record that and carry on.
 *   failed         put the topic back on the FRONT of the queue and give the
 *                  weekly slot back. The next tick retries it.
 *
 * A run the runner can no longer identify is the one case that is not rolled
 * back. If it did succeed, returning the topic would commission the same post
 * twice, and a duplicate is worse than a gap — the gap is visible in the queue,
 * the duplicate is only visible to a reader.
 */

import { createRequire } from 'module';

process.env.STRAPI_SKIP_POLLERS = '1';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

const UID = 'api::content-populator.content-populator';
const RUNNER_URL = (process.env.RUNNER_URL || 'http://172.18.0.1:4310').replace(/\/$/, '');
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
  /* The runner replies { run: {...} }, not the run itself. Reading body.id
     here instead of body.run.id is why lastRunId was written as an empty
     string on every dispatch - which in turn meant nothing could ever be
     reconciled, because the reconcile pass has no run to look up. */
  const run = body.run ?? body;
  if (!run.id) throw new Error('runner accepted the job but returned no run id');
  return run;
}

/**
 * What became of a run. Returns null when the runner cannot be reached, which
 * is deliberately different from "the run failed" — one is our problem and
 * resolves itself, the other is the populator's and needs the topic back.
 */
async function fetchRun(runId) {
  try {
    const res = await fetch(`${RUNNER_URL}/api/runs/${encodeURIComponent(runId)}`, {
      headers: RUNNER_TOKEN ? { Authorization: `Bearer ${RUNNER_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { status: 'unknown' };
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return body.run ?? null;
  } catch {
    return null;
  }
}

/**
 * Settle the previous run before deciding anything else about this populator.
 *
 * Returns the populator as it should now be read - with the rollback already
 * applied when the run failed - or null when it is still working and this tick
 * should leave it be.
 */
async function reconcile(strapi, p) {
  if (p.lastRunStatus !== 'started' || !p.lastRunId) return p;

  const run = await fetchRun(p.lastRunId);

  if (!run) {
    console.log(`  waiting  ${p.name} - runner unreachable, leaving last run open`);
    return null;
  }

  if (run.status === 'running') {
    console.log(`  busy     ${p.name} - previous run still going`);
    return null;
  }

  if (run.status === 'succeeded') {
    const data = { lastRunStatus: 'succeeded' };
    await strapi.documents(UID).update({ documentId: p.documentId, data });
    return { ...p, ...data };
  }

  if (run.status === 'unknown') {
    // Not rolled back on purpose - see the note at the top of this file.
    const data = { lastRunStatus: 'unknown: run record gone from the runner' };
    await strapi.documents(UID).update({ documentId: p.documentId, data });
    console.log(`  ?        ${p.name} - run ${p.lastRunId} no longer on the runner, topic left consumed`);
    return { ...p, ...data };
  }

  // failed / cancelled / interrupted: give back what the dispatch took.
  const used = Array.isArray(p.topicsUsed) ? [...p.topicsUsed] : [];
  const topic = used.pop();
  const queue = Array.isArray(p.topicQueue) ? [...p.topicQueue] : [];
  if (topic !== undefined) queue.unshift(topic);

  const data = {
    topicQueue: queue,
    topicsUsed: used,
    runsThisWeek: Math.max(0, (p.runsThisWeek ?? 1) - 1),
    lastRunStatus: `${run.status}${run.exitCode != null ? ` (exit ${run.exitCode})` : ''}`.slice(0, 200),
  };
  await strapi.documents(UID).update({ documentId: p.documentId, data });
  console.log(
    `  rolled   ${p.name} - run ${run.status}, "${String(topic ?? '?').slice(0, 40)}" back on the queue, slot returned`,
  );
  return { ...p, ...data };
}

async function main() {
  const strapi = await createStrapi().load();
  strapi.log.level = 'error';
  const now = Date.now();

  try {
    const populators = await strapi.documents(UID).findMany({ populate: { site: true }, limit: 200 });

    console.log(`${populators.length} populator(s), ${populators.filter((p) => p.enabled).length} enabled${DRY_RUN ? ' (dry run)' : ''}`);

    for (const raw of populators) {
      if (!raw.enabled) continue;

      /* Settle the last run first. A populator that is not due can still be
         holding a finished run that needs recording, or a failed one whose
         topic belongs back on the queue - skipping it here would strand both
         until the cadence next came round. */
      const p = DRY_RUN ? raw : await reconcile(strapi, raw);
      if (!p) continue;

      if (!isDue(p, now)) continue;

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
          lastRunId: String(run.id),
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
