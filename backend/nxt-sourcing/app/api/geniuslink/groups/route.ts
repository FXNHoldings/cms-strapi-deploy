import { NextResponse } from 'next/server';
import { hasGeniuslinkConfig, listGeniuslinkGroups } from '@/lib/geniuslink';

export async function GET() {
  if (!hasGeniuslinkConfig()) {
    return NextResponse.json(
      { ok: false, message: 'GENIUSLINK_API_KEY and GENIUSLINK_API_SECRET are not configured.' },
      { status: 400 },
    );
  }

  try {
    const groups = await listGeniuslinkGroups();
    return NextResponse.json({ ok: true, groups });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'Geniuslink groups request failed.' },
      { status: 500 },
    );
  }
}
