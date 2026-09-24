/**
 * Spread publish dates for the bestlooking.skin content-plan posts over a
 * window, so a batch of 75 does not all carry the same timestamp.
 *
 *   node backdate-posts.mjs                # dry run
 *   node backdate-posts.mjs --write
 *   node backdate-posts.mjs --write --weeks=10
 *
 * Run it AFTER publishing. publishedAt lives on a document's published row, so
 * a draft has none, and Strapi stamps it at publish time -- there is nothing to
 * backdate until the post is live. Re-run it after each batch you publish.
 *
 * Why SQL and not the REST API: the Content API ignores an explicit
 * publishedAt. Sending one returns 200 and writes the current time instead,
 * which reads exactly like success. Measured, not assumed.
 *
 * Dates are assigned deterministically from the slug, so a re-run keeps every
 * post on the date it already had and only fills in newly published ones. The
 * spread is irregular (weekday-biased, working hours) rather than evenly
 * spaced, because a post every 47 hours on the dot looks generated.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const run = promisify(execFile);
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const WEEKS = Number((args.find((a) => a.startsWith('--weeks=')) || '').split('=')[1] || 10);

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const slugs = fs.readFileSync(path.join(ROOT, 'topics/bestlooking-75.txt'), 'utf8')
  .split('\n').filter(Boolean).map((l) => l.split('|')[2].trim());

async function psql(sql) {
  const { stdout } = await run('docker', [
    'exec', 'strapi-cms-postgres', 'psql', '-U', 'strapi', '-d', 'strapi', '-t', '-A', '-F', '|', '-c', sql,
  ], { maxBuffer: 1024 * 1024 * 8 });
  return stdout.trim().split('\n').filter(Boolean);
}

const list = slugs.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
const rows = await psql(
  `select id, slug, published_at from bls_posts where slug in (${list}) and published_at is not null order by slug;`,
);

if (!rows.length) {
  console.log('No published posts among the 75 yet -- publish first, then run this.');
  process.exit(0);
}

const now = new Date();
const windowMs = WEEKS * 7 * 24 * 3600 * 1000;

/** Deterministic pseudo-random in [0,1) from the slug. */
function seeded(slug, salt) {
  const h = crypto.createHash('sha256').update(`${slug}:${salt}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

const updates = [];
for (const row of rows) {
  const [id, slug] = row.split('|');
  // Bias toward recent: sqrt pushes the distribution to the newer half, so the
  // archive thins out going back rather than being uniformly dense.
  const frac = Math.sqrt(seeded(slug, 'day'));
  let d = new Date(now.getTime() - frac * windowMs);
  // Nudge weekends onto the Friday before -- a publishing schedule with no
  // weekday pattern at all is its own tell.
  const dow = d.getUTCDay();
  if (dow === 0) d = new Date(d.getTime() - 2 * 86400000);
  if (dow === 6) d = new Date(d.getTime() - 86400000);
  // Working hours, 08:00-18:00 UTC, minute resolution.
  d.setUTCHours(8 + Math.floor(seeded(slug, 'hour') * 10), Math.floor(seeded(slug, 'min') * 60), 0, 0);
  updates.push({ id, slug, iso: d.toISOString() });
}

updates.sort((a, b) => a.iso.localeCompare(b.iso));
for (const u of updates) console.log(`  ${u.iso.slice(0, 16).replace('T', ' ')}  ${u.slug}`);
console.log(`\n  ${updates.length} published post(s), spread over ${WEEKS} weeks`);
console.log(`  oldest ${updates[0].iso.slice(0, 10)}  newest ${updates[updates.length - 1].iso.slice(0, 10)}`);

if (!WRITE) { console.log('\ndry run -- nothing written.'); process.exit(0); }

const cases = updates.map((u) => `when ${u.id} then timestamptz '${u.iso}'`).join(' ');
const ids = updates.map((u) => u.id).join(',');
await psql(`update bls_posts set published_at = case id ${cases} end where id in (${ids});`);
console.log('\nwritten.');
