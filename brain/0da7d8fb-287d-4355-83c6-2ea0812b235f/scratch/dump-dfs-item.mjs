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

loadEnvFile('/opt/projects/nxt.bargains/.env.local');

const BASIC = process.env.DATAFORSEO_PASSWORD;
const headers = { Authorization: `Basic ${BASIC}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function dumpGoogleShoppingProduct() {
  const postRes = await fetch('https://api.dataforseo.com/v3/merchant/google/products/task_post', {
    method: 'POST',
    headers,
    body: JSON.stringify([{ keyword: 'smart door lock', location_code: 2840, language_code: 'en', depth: 20 }])
  });
  const postData = await postRes.json();
  const taskId = postData.tasks?.[0]?.id;
  await sleep(6000);
  const getRes = await fetch(`https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced/${taskId}`, { headers });
  const getData = await getRes.json();
  const items = getData.tasks?.[0]?.result?.[0]?.items || [];
  const valid = items.filter(i => i.type === 'shopping' || i.title);
  console.log('Sample product item:\n', JSON.stringify(valid[1] || valid[0], null, 2));
}

dumpGoogleShoppingProduct().catch(console.error);
