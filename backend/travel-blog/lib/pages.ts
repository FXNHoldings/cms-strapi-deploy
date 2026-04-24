import fs from 'fs/promises';
import path from 'path';

export async function readPageMarkdown(slug: string): Promise<string | null> {
  const filePath = path.join(process.cwd(), 'content', 'pages', `${slug}.md`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Strip the first H1 — it becomes the page heading rendered by the template
    return raw.replace(/^#\s+.+\n+/, '').trimStart();
  } catch {
    return null;
  }
}
