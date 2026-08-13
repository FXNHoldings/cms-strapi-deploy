/**
 * Publish Strapi `fxnseo-post` entries to the live fxnseo.com blog.
 *
 *   node sync-fxnseo-posts.js                 # dry run — shows what it would do
 *   node sync-fxnseo-posts.js --write
 *   node sync-fxnseo-posts.js --write --no-images
 *
 * Strapi and the SumoSEO (Laravel) site are two separate databases with nothing
 * linking them. Until this script existed, a post only reached fxnseo.com if
 * `generate-fxnseo-post.js` imported it during the same run — so anything
 * written straight into the Strapi admin stayed invisible on the site forever.
 *
 * Three things this gets right that the older path did not:
 *
 *   1. It talks to the LIVE host over SSH. `generate-fxnseo-post.js` runs
 *      `sumoseo-import-post.php` at a local path which, on this machine, is a
 *      DISABLED copy of the site with its own database — so its writes landed
 *      nowhere while reporting success.
 *   2. It sends `publish: true`. The importer defaults to draft
 *      (`!empty($data['publish']) ? 1 : 0`), and a draft is hidden from /blog,
 *      which looks identical to the post never arriving.
 *   3. It is idempotent. Slugs already on the live site are skipped rather than
 *      re-imported, because the importer de-duplicates by appending a suffix and
 *      would otherwise create `my-post-2` on every run.
 *
 * Safe to cron. Exits non-zero if any post failed, so a wrapper can alert.
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const NO_IMAGES = args.includes('--no-images');

const STRAPI_URL = (process.env.STRAPI_URL || process.env.STRAPI_INTERNAL_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || process.env.STRAPI_TOKEN || '';
const MEDIA_ORIGIN = process.env.FXNSEO_MEDIA_ORIGIN || 'https://strapi.fxnstudio.com';
const LIVE_HOST = process.env.FXNSEO_LIVE_HOST || 'root@178.105.206.112';
const LIVE_APP_DIR = process.env.FXNSEO_LIVE_APP_DIR || '/var/www/html/fxnseo.com/components';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

async function strapi(pathname) {
  const res = await fetch(`${STRAPI_URL}${pathname}`, {
    headers: STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return res.json();
}

async function ssh(command) {
  const { stdout } = await execFileAsync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', LIVE_HOST, command], { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** Slug -> featured_image for every post on the live site. */
async function liveposts() {
  const php =
    'foreach(DB::table("pages")->where("type","post")->get(["slug","featured_image","post_status"]) as $p) ' +
    'echo $p->slug."\\t".($p->featured_image ?: "")."\\t".$p->post_status.PHP_EOL;';
  const out = await ssh(`cd ${LIVE_APP_DIR} && php artisan tinker --execute='${php}' 2>/dev/null`);
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line.includes('\t')) continue;
    const [slug, image, status] = line.split('\t');
    if (slug) map.set(slug.trim(), { image: (image || '').trim(), status: Number(status) });
  }
  return map;
}

/** Hand a JSON payload to the live importer and return its parsed reply. */
async function runImporter(payload, tag) {
  const name = `fxnseo-sync-${tag}-${process.pid}.json`;
  const tmp = path.join(os.tmpdir(), name);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  try {
    await execFileAsync('scp', ['-q', '-o', 'BatchMode=yes', tmp, `${LIVE_HOST}:/tmp/${name}`]);
    const out = await ssh(
      `chmod 644 /tmp/${name} && cd ${LIVE_APP_DIR} && ` +
      `sudo -u www-data php sumoseo-import-post.php /tmp/${name}; rm -f /tmp/${name}`,
    );
    const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
    const parsed = JSON.parse(line);
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/* --------------------------------------------------------------------- main */

const res = await strapi('/api/fxnseo-posts?populate=coverImage&pagination[pageSize]=200&status=published');
const posts = (res.data ?? []).filter((p) => p.slug && p.title);
const live = await liveposts();

log(`strapi published: ${posts.length}   live posts: ${live.size}   mode: ${WRITE ? 'WRITE' : 'DRY RUN'}`);

const toImport = posts.filter((p) => !live.has(p.slug));
const needImage = posts.filter((p) => live.has(p.slug) && !live.get(p.slug).image);
const unpublished = posts.filter((p) => live.get(p.slug)?.status === 0);

log(`to import: ${toImport.length}   missing cover: ${needImage.length}   imported-but-draft: ${unpublished.length}`);

let failed = 0;
const coverNeeded = [];

for (const p of toImport) {
  log(`import ${p.slug}`);
  if (!WRITE) { coverNeeded.push(p); continue; }
  try {
    const out = await runImporter({
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt ?? '',
      content: p.content ?? '',
      seoTitle: p.seoTitle ?? p.title,
      seoDescription: p.seoDescription ?? p.excerpt ?? '',
      // Without this the importer creates a draft, hidden from /blog.
      publish: true,
    }, p.slug.slice(0, 30));
    log(`  imported as page ${out.id}`);
    coverNeeded.push(p);
  } catch (e) {
    failed += 1;
    log(`  FAILED: ${String(e.message).slice(0, 180)}`);
  }
}

/* A post already on the site but left as a draft is invisible; publish it. */
for (const p of unpublished) {
  log(`publishing draft ${p.slug}`);
  if (!WRITE) continue;
  try {
    await ssh(`cd ${LIVE_APP_DIR} && php artisan tinker --execute='DB::table("pages")->where("slug","${p.slug}")->where("type","post")->update(["post_status"=>1]);' 2>/dev/null`);
    log('  published');
  } catch (e) {
    failed += 1;
    log(`  FAILED: ${String(e.message).slice(0, 160)}`);
  }
}

/* Covers: reuse a Strapi cover when there is one, otherwise generate. */
const generate = [];
for (const p of [...coverNeeded, ...needImage]) {
  const url = p.coverImage?.url;
  if (url) {
    const publicUrl = url.startsWith('http') ? url : `${MEDIA_ORIGIN}${url}`;
    log(`cover from strapi ${p.slug}`);
    if (!WRITE) continue;
    try {
      await runImporter({ slug: p.slug, featured_image: publicUrl, set_featured_image_only: true }, `img-${p.slug.slice(0, 26)}`);
      log('  featured_image set');
    } catch (e) {
      failed += 1;
      log(`  FAILED: ${String(e.message).slice(0, 160)}`);
    }
  } else {
    generate.push(p.slug);
  }
}

if (generate.length && !NO_IMAGES) {
  log(`generating ${generate.length} cover(s) via regenerate-fxnseo-covers.js`);
  for (const slug of generate) {
    if (!WRITE) { log(`  would generate ${slug}`); continue; }
    try {
      const { stdout } = await execFileAsync('node',
        [path.join(SCRIPT_DIR, 'regenerate-fxnseo-covers.js'), '--write', `--slug=${slug}`],
        { cwd: SCRIPT_DIR, maxBuffer: 4 * 1024 * 1024 });
      log(`  ${slug}: ${/regenerated 1/.test(stdout) ? 'cover generated' : 'no cover produced'}`);
      if (!/regenerated 1/.test(stdout)) failed += 1;
    } catch (e) {
      failed += 1;
      log(`  ${slug} FAILED: ${String(e.message).slice(0, 160)}`);
    }
  }
}

log(`done. failures: ${failed}`);
process.exit(failed ? 1 : 0);
