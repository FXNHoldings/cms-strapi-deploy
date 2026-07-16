import { NextResponse } from 'next/server';
import { createGeniuslinkShortUrl, hasGeniuslinkConfig } from '@/lib/geniuslink';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : undefined;
  const vanityCode = typeof body.vanityCode === 'string' ? body.vanityCode.trim() : undefined;
  const domain = typeof body.domain === 'string' ? body.domain.trim() : undefined;
  const groupId = Number(body.groupId);

  if (!url || !isHttpUrl(url)) {
    return NextResponse.json({ ok: false, message: 'Enter a valid http(s) URL.' }, { status: 400 });
  }

  if (!hasGeniuslinkConfig()) {
    return NextResponse.json(
      { ok: false, message: 'GENIUSLINK_API_KEY and GENIUSLINK_API_SECRET are not configured.' },
      { status: 400 },
    );
  }

  try {
    const result = await createGeniuslinkShortUrl({
      url,
      note,
      vanityCode,
      domain,
      groupId: Number.isFinite(groupId) && groupId > 0 ? groupId : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Geniuslink create failed.' },
      { status: 500 },
    );
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
