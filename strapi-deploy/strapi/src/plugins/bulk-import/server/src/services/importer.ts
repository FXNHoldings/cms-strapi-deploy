import matter from 'gray-matter';
import { parse as csvParse } from 'csv-parse/sync';
import slugify from 'slugify';
import fs from 'node:fs';

type ImportReport = {
  created: number;
  skipped: number;
  errors: { row?: number; file?: string; message: string }[];
  items: { id: number; title: string; slug: string }[];
};

export default ({ strapi }) => ({
  /**
   * Import one or more Markdown files. Each .md may have YAML frontmatter:
   * ---
   * title: My post
   * excerpt: short summary
   * category: Flights
   * tags: [cheap, asia]
   * destinations: [Bangkok]
   * seoTitle: ...
   * seoDescription: ...
   * ---
   * # Body in markdown...
   */
  async importMarkdown(files: { name: string; buffer: Buffer }[]): Promise<ImportReport> {
    const report: ImportReport = { created: 0, skipped: 0, errors: [], items: [] };

    for (const f of files) {
      try {
        const raw = f.buffer.toString('utf8');
        const { data, content } = matter(raw);
        const title = data.title || f.name.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
        const slug = (data.slug as string) || slugify(title, { lower: true, strict: true }).slice(0, 60);

        const existing = await strapi.db.query('api::article.article').findOne({ where: { slug } });
        if (existing) {
          report.skipped++;
          report.errors.push({ file: f.name, message: `slug "${slug}" already exists` });
          continue;
        }

        const categoryId = await resolveCategory(strapi, data.category);
        const tagIds = await resolveTags(strapi, data.tags);
        const destinationIds = await resolveDestinations(strapi, data.destinations);
        const authorId = await resolveAuthor(strapi, data.author);

        const article = await strapi.entityService.create('api::article.article', {
          data: {
            title,
            slug,
            excerpt: data.excerpt || '',
            content,
            seoTitle: data.seoTitle || title,
            seoDescription: data.seoDescription || data.excerpt || '',
            seoKeywords: Array.isArray(data.keywords) ? data.keywords.join(', ') : data.keywords || '',
            readingTimeMinutes: data.readingTimeMinutes || estimateReadingTime(content),
            source: 'markdown-import',
            category: categoryId,
            tags: tagIds,
            destinations: destinationIds,
            author: authorId,
          },
        });

        report.created++;
        report.items.push({ id: (article as any).id, title, slug });
      } catch (e: any) {
        report.errors.push({ file: f.name, message: e.message || 'unknown error' });
      }
    }

    return report;
  },

  /**
   * Import CSV with columns:
   * title,slug,excerpt,content,category,tags,destinations,author,seoTitle,seoDescription,keywords
   * tags / destinations / keywords may be pipe-separated: "asia|cheap"
   */
  async importCsv(buffer: Buffer): Promise<ImportReport> {
    const report: ImportReport = { created: 0, skipped: 0, errors: [], items: [] };
    const rows = csvParse(buffer, { columns: true, skip_empty_lines: true, trim: true });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (!row.title || !row.content) {
          report.errors.push({ row: i + 2, message: 'missing title or content' });
          report.skipped++;
          continue;
        }
        const slug = row.slug || slugify(row.title, { lower: true, strict: true }).slice(0, 60);
        const existing = await strapi.db.query('api::article.article').findOne({ where: { slug } });
        if (existing) {
          report.skipped++;
          report.errors.push({ row: i + 2, message: `slug "${slug}" already exists` });
          continue;
        }

        const categoryId = await resolveCategory(strapi, row.category);
        const tagIds = await resolveTags(strapi, splitList(row.tags));
        const destinationIds = await resolveDestinations(strapi, splitList(row.destinations));
        const authorId = await resolveAuthor(strapi, row.author);

        const article = await strapi.entityService.create('api::article.article', {
          data: {
            title: row.title,
            slug,
            excerpt: row.excerpt || '',
            content: row.content,
            seoTitle: row.seoTitle || row.title,
            seoDescription: row.seoDescription || row.excerpt || '',
            seoKeywords: row.keywords || '',
            readingTimeMinutes: Number(row.readingTimeMinutes) || estimateReadingTime(row.content),
            source: 'csv-import',
            category: categoryId,
            tags: tagIds,
            destinations: destinationIds,
            author: authorId,
          },
        });
        report.created++;
        report.items.push({ id: (article as any).id, title: row.title, slug });
      } catch (e: any) {
        report.errors.push({ row: i + 2, message: e.message || 'unknown error' });
      }
    }
    return report;
  },
});

function splitList(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v).split('|').map((s) => s.trim()).filter(Boolean);
}

function estimateReadingTime(text: string) {
  const words = (text || '').split(/\s+/).length;
  return Math.max(1, Math.round(words / 220));
}

async function resolveCategory(strapi, name?: string) {
  if (!name) return null;
  const found = await strapi.db.query('api::category.category').findOne({ where: { name } });
  if (found) return found.id;
  const created = await strapi.entityService.create('api::category.category', {
    data: { name, slug: slugify(name, { lower: true, strict: true }) },
  });
  return (created as any).id;
}

async function resolveTags(strapi, names?: any) {
  const list = splitList(names);
  const ids: number[] = [];
  for (const n of list) {
    const found = await strapi.db.query('api::tag.tag').findOne({ where: { name: n } });
    if (found) { ids.push(found.id); continue; }
    const created = await strapi.entityService.create('api::tag.tag', {
      data: { name: n, slug: slugify(n, { lower: true, strict: true }) },
    });
    ids.push((created as any).id);
  }
  return ids;
}

async function resolveDestinations(strapi, names?: any) {
  const list = splitList(names);
  const ids: number[] = [];
  for (const n of list) {
    const found = await strapi.db.query('api::destination.destination').findOne({ where: { name: n } });
    if (found) { ids.push(found.id); continue; }
    const created = await strapi.entityService.create('api::destination.destination', {
      data: { name: n, slug: slugify(n, { lower: true, strict: true }), type: 'city' },
    });
    ids.push((created as any).id);
  }
  return ids;
}

async function resolveAuthor(strapi, name?: string) {
  if (!name) return null;
  const found = await strapi.db.query('api::author.author').findOne({ where: { name } });
  if (found) return found.id;
  const created = await strapi.entityService.create('api::author.author', {
    data: { name, slug: slugify(name, { lower: true, strict: true }) },
  });
  return (created as any).id;
}
