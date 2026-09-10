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

async function fetchGoogleShoppingProducts(keyword) {
  console.log(`\nFetching DataForSEO Google Shopping products for keyword: "${keyword}"...`);
  const payload = [{
    keyword,
    location_code: 2840,
    language_code: 'en',
    depth: 20
  }];

  const postRes = await fetch('https://api.dataforseo.com/v3/merchant/google/products/task_post', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const postData = await postRes.json();
  const taskId = postData.tasks?.[0]?.id;
  if (!taskId) {
    throw new Error(`Task post failed: ${postData.tasks?.[0]?.status_message}`);
  }
  console.log('Task ID created:', taskId);

  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const getRes = await fetch(`https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced/${taskId}`, {
      headers
    });
    const getData = await getRes.json();
    const task = getData.tasks?.[0];
    if (task && task.status_code === 20000) {
      const items = task.result?.[0]?.items || [];
      console.log(`Successfully retrieved ${items.length} Google Shopping products!`);
      if (items[0]) {
        console.log('Sample product:', JSON.stringify({
          title: items[0].title,
          price: items[0].price,
          rating: items[0].rating?.value || items[0].rating,
          reviews_count: items[0].rating?.votes_count || items[0].reviews_count,
          seller: items[0].seller,
          url: items[0].url || items[0].shopping_url,
          image: items[0].product_image || items[0].image_url
        }, null, 2));
      }
      return items;
    }
    console.log(`Waiting for task results... (attempt ${i + 1})`);
  }
  return [];
}

fetchGoogleShoppingProducts('smart entry door lock').catch(console.error);
