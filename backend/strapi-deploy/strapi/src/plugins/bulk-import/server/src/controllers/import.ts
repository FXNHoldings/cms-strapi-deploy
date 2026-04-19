import fs from 'node:fs';

function toArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export default {
  /**
   * POST /bulk-import/markdown  (multipart files[])
   * POST /bulk-import/csv       (multipart file)
   */
  async markdown(ctx) {
    const files = toArray<any>(ctx.request.files?.files);
    if (!files.length) return ctx.badRequest('No files uploaded (field name: files)');

    const prepared = files.map((f) => ({
      name: f.originalFilename || f.name || 'upload.md',
      buffer: fs.readFileSync(f.filepath || f.path),
    }));

    const report = await strapi.plugin('bulk-import').service('importer').importMarkdown(prepared);
    ctx.body = report;
  },

  async csv(ctx) {
    const file = toArray<any>(ctx.request.files?.file)[0];
    if (!file) return ctx.badRequest('No file uploaded (field name: file)');
    const buf = fs.readFileSync(file.filepath || file.path);
    const report = await strapi.plugin('bulk-import').service('importer').importCsv(buf);
    ctx.body = report;
  },
};
