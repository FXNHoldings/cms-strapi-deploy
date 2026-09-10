import { existsSync, readFileSync } from 'node:fs';

function loadEnvFile(filepath) {
  if (!existsSync(filepath)) return;
  const content = readFileSync(filepath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

loadEnvFile('/opt/strapi-cms-git/backend/ai-writer-cli/.env');

const STRAPI_BASE = process.env.STRAPI_URL || 'http://127.0.0.1:8888';
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;

async function run() {
  const res = await fetch(`${STRAPI_BASE}/api/nxt-posts?filters[slug][$eq]=smart-entry&populate=*`, {
    headers: STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}
  });
  const data = await res.json();
  const post = data.data?.[0];
  console.log('Title:', post.title);
  console.log('Slug:', post.slug);
  console.log('Excerpt:', post.excerpt);
  console.log('Content:\n', post.content);
}

run().catch(console.error);
