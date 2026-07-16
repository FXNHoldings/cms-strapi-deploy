import { NextResponse } from 'next/server';
import { STRAPI_URL, strapiHeaders } from '@/lib/config';

// Lists existing commerce-categories so the search page can offer them in the
// bulk-add "target category" picker. Falls back to an empty list on error.
export async function GET() {
  try {
    const params = new URLSearchParams({
      'fields[0]': 'name',
      'fields[1]': 'slug',
      'pagination[pageSize]': '200',
      'sort[0]': 'name:asc',
    });
    const res = await fetch(`${STRAPI_URL}/api/commerce-categories?${params.toString()}`, {
      headers: strapiHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ categories: [] });
    const json = await res.json();
    const categories = (json?.data ?? [])
      .map((row: Record<string, unknown>) => {
        const attrs = (row.attributes as Record<string, unknown>) ?? row;
        return { name: attrs.name as string, slug: attrs.slug as string };
      })
      .filter((c: { name?: string }) => c.name);
    return NextResponse.json({ categories });
  } catch {
    return NextResponse.json({ categories: [] });
  }
}
