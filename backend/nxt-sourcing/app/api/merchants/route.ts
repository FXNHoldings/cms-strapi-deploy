import { NextResponse } from 'next/server';
import { getCommerceMerchants } from '@/lib/merchants';

export async function GET() {
  const merchants = await getCommerceMerchants();
  return NextResponse.json({ merchants });
}
