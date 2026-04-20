import { revalidateTag, revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.REVALIDATE_SECRET || secret !== process.env.REVALIDATE_SECRET) {
    return NextResponse.json({ ok: false, error: 'bad secret' }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const slug: string | undefined = body?.entry?.slug;

  // Blunt but safe: revalidate the paths most likely affected by any publish
  revalidatePath('/');
  revalidatePath('/articles');
  revalidatePath('/destinations');
  if (slug) {
    revalidatePath(`/articles/${slug}`);
  }
  revalidateTag('strapi');
  return NextResponse.json({ ok: true, revalidated: ['/', '/articles', '/destinations', slug && `/articles/${slug}`].filter(Boolean) });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST here with ?secret=… to trigger ISR revalidation' });
}
