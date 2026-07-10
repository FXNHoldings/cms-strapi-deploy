/* eslint-disable no-console */
'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStrapi } = require('@strapi/strapi');

process.on('uncaughtException', (error) => {
  if (error?.message === 'aborted') process.exit(0);
  throw error;
});

const LOGOS = [
  { slug: 'amazon', domain: 'amazon.com', filename: 'merchant-amazon-logo' },
  { slug: 'walmart', domain: 'walmart.com', filename: 'merchant-walmart-logo' },
  { slug: 'ebay', domain: 'ebay.com', filename: 'merchant-ebay-logo' },
  { slug: 'target', domain: 'target.com', filename: 'merchant-target-logo' },
  { slug: 'best-buy', domain: 'bestbuy.com', filename: 'merchant-best-buy-logo' },
  { slug: 'sephora', domain: 'sephora.com', filename: 'merchant-sephora-logo' },
  { slug: 'ulta', domain: 'ulta.com', filename: 'merchant-ulta-logo' },
  { slug: 'currys', domain: 'currys.co.uk', filename: 'merchant-currys-logo' },
  { slug: 'argos', domain: 'argos.co.uk', filename: 'merchant-argos-logo' },
  { slug: 'aliexpress', domain: 'aliexpress.com', filename: 'merchant-aliexpress-logo' },
];

function logoUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`;
}

function extensionFor(mime) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}

async function uploadLogo(strapi, url, filename) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);

  const mime = response.headers.get('content-type') || 'image/png';
  const extension = extensionFor(mime);
  const buffer = Buffer.from(await response.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `${filename}-${Date.now()}.${extension}`);
  fs.writeFileSync(tmp, buffer);

  try {
    const stats = fs.statSync(tmp);
    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: {
        fileInfo: {
          name: filename,
          alternativeText: filename.replace(/^merchant-/, '').replace(/-/g, ' '),
        },
      },
      files: {
        filepath: tmp,
        originalFilename: `${filename}.${extension}`,
        mimetype: mime,
        size: stats.size,
      },
    });
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    if (!file?.id) throw new Error(`Upload returned no file id for ${filename}`);
    return file;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function main() {
  const strapi = await createStrapi().load();
  const stats = { uploaded: 0, skipped: 0, missing: 0 };

  try {
    for (const item of LOGOS) {
      const merchants = await strapi.documents('api::commerce-merchant.commerce-merchant').findMany({
        status: 'published',
        filters: { slug: { $eq: item.slug } },
        populate: { logo: true },
        pagination: { pageSize: 1 },
      });
      const merchant = merchants[0];
      if (!merchant) {
        stats.missing++;
        console.warn(`Missing merchant: ${item.slug}`);
        continue;
      }

      if (merchant.logo?.id && process.env.FORCE_LOGO_UPLOAD !== '1') {
        stats.skipped++;
        continue;
      }

      const file = await uploadLogo(strapi, logoUrl(item.domain), item.filename);
      await strapi.documents('api::commerce-merchant.commerce-merchant').update({
        documentId: merchant.documentId,
        status: 'published',
        data: { logo: file.id },
      });
      stats.uploaded++;
      console.log(`Attached logo for ${merchant.name}: ${file.url}`);
    }

    console.log(JSON.stringify(stats, null, 2));
  } finally {
    await strapi.destroy().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
