import { NextResponse } from 'next/server';
import { refreshAllProductPrices, refreshMerchantProductPrices } from '@/lib/strapi-commerce';
import { checkPriceAlerts } from '@/lib/price-alerts';

// Long-running: re-prices products one by one against the provider API.
export const maxDuration = 800;
export const dynamic = 'force-dynamic';

// Daily price-refresh endpoint, triggered by cron. Protected by a shared
// secret (PRICE_REFRESH_SECRET) so it can't be hit publicly.
export async function POST(request: Request) {
  const secret = process.env.PRICE_REFRESH_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const body = await request.json().catch(() => ({}));
  try {
    const merchantSlugs = Array.isArray(body.merchants)
      ? body.merchants.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    const result = merchantSlugs.length
      ? await refreshMerchantProductPrices({
          merchantSlugs,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
      : await refreshAllProductPrices({ limit: typeof body.limit === 'number' ? body.limit : undefined });
    // After re-pricing, fire any price alerts that have now hit their target.
    let alerts: Awaited<ReturnType<typeof checkPriceAlerts>> | { error: string } | undefined;
    try {
      alerts = await checkPriceAlerts();
    } catch (alertError) {
      alerts = { error: alertError instanceof Error ? alertError.message : 'alert check failed' };
    }
    return NextResponse.json({ ok: true, ...result, alerts });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : 'refresh failed' },
      { status: 500 },
    );
  }
}
