import { listArticles, mediaUrl } from '@/lib/strapi';

const SITE_URL = 'https://www.originfacts.com';
const FEED_TITLE = 'Originfacts';
const FEED_DESCRIPTION =
  'The facts behind every place worth visiting — plus the latest on flights, hotels, airlines, airports and destinations.';

export const revalidate = 600;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export async function GET() {
  const { data: articles } = await listArticles({ pageSize: 30 }).catch(
    () => ({ data: [], meta: { pagination: { page: 1, pageSize: 30, pageCount: 0, total: 0 } } }),
  );

  const lastBuildDate = articles[0]?.publishedAt
    ? new Date(articles[0].publishedAt).toUTCString()
    : new Date().toUTCString();

  const items = articles
    .map((a) => {
      const link = `${SITE_URL}/articles/${a.slug}`;
      const pubDate = a.publishedAt ? new Date(a.publishedAt).toUTCString() : '';
      const cover = mediaUrl(a.coverImage ?? null);
      const description = a.excerpt || a.seoDescription || '';
      const categoryTag = a.category
        ? `<category>${escapeXml(a.category.name)}</category>`
        : '';
      const enclosure = cover
        ? `<enclosure url="${escapeXml(cover)}" type="image/jpeg" />`
        : '';
      const author = a.author?.name ? `<dc:creator>${cdata(a.author.name)}</dc:creator>` : '';

      return `    <item>
      <title>${cdata(a.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      ${author}
      ${categoryTag}
      <description>${cdata(description)}</description>
      ${enclosure}
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${cdata(FEED_TITLE)}</title>
    <link>${SITE_URL}</link>
    <description>${cdata(FEED_DESCRIPTION)}</description>
    <language>en</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
    },
  });
}
