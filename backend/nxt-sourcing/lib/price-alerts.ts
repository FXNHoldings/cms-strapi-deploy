import { ALERT_SITE_URL, STRAPI_API_TOKEN, STRAPI_URL, strapiHeaders } from './config';
import { sendBrevoEmail } from './email';

type StrapiItem = Record<string, any>;

/**
 * Check every active price alert against the product's current lowest price.
 * When the live price is at or below the visitor's target, send a Brevo email
 * and mark the alert "triggered" so it only fires once. Intended to run right
 * after refreshAllProductPrices() in the daily cron.
 */
export async function checkPriceAlerts(): Promise<{
  checked: number;
  triggered: number;
  sent: number;
  failed: number;
}> {
  if (!STRAPI_API_TOKEN) throw new Error('STRAPI_API_TOKEN is not configured.');

  let page = 1;
  const pageSize = 50;
  let checked = 0;
  let triggered = 0;
  let sent = 0;
  let failed = 0;
  const now = new Date().toISOString();

  while (true) {
    const params = new URLSearchParams({
      'filters[alertStatus][$eq]': 'active',
      'pagination[page]': String(page),
      'pagination[pageSize]': String(pageSize),
      'populate[product][populate][0]': 'offers',
      'populate[product][populate][1]': 'primaryImage',
    });

    const res = await fetch(`${STRAPI_URL}/api/commerce-price-alerts?${params.toString()}`, {
      headers: strapiHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Strapi alert list failed: HTTP ${res.status}`);
    const json = await res.json();
    const rows: StrapiItem[] = json?.data ?? [];
    if (!rows.length) break;

    for (const alert of rows) {
      checked += 1;
      const product = alert.product as StrapiItem | undefined;
      const target = Number(alert.targetPrice);
      if (!product || !Number.isFinite(target)) {
        await updateAlert(alert.documentId, { lastCheckedAt: now });
        continue;
      }

      const current = lowestOfferPrice(product);
      if (current === null) {
        await updateAlert(alert.documentId, { lastCheckedAt: now });
        continue;
      }

      if (current <= target) {
        triggered += 1;
        const result = await notify(alert, product, current);
        if (result.ok) sent += 1;
        else failed += 1;
        await updateAlert(alert.documentId, {
          alertStatus: result.ok ? 'triggered' : 'active',
          triggeredAt: result.ok ? now : undefined,
          notifiedPrice: result.ok ? current : undefined,
          lastCheckedAt: now,
        });
      } else {
        await updateAlert(alert.documentId, { lastCheckedAt: now });
      }
    }

    const pageCount = json?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page += 1;
  }

  return { checked, triggered, sent, failed };
}

function lowestOfferPrice(product: StrapiItem): number | null {
  const offers = Array.isArray(product.offers) ? product.offers : [];
  const prices = offers
    .filter((o: StrapiItem) => o?.availability !== 'out_of_stock')
    .map((o: StrapiItem) => Number(o?.price))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  if (!prices.length) return null;
  return Math.min(...prices);
}

async function notify(alert: StrapiItem, product: StrapiItem, current: number) {
  const currency = alert.currency || 'USD';
  const fmt = (n: number) => `${currency === 'USD' ? '$' : ''}${n.toFixed(2)}${currency === 'USD' ? '' : ' ' + currency}`;
  const productUrl = `${ALERT_SITE_URL}/products/${product.slug}`;
  const cancelUrl = alert.cancelToken
    ? `${ALERT_SITE_URL}/api/price-alert/cancel?token=${encodeURIComponent(alert.cancelToken)}&id=${encodeURIComponent(alert.documentId)}`
    : productUrl;

  const subject = `Price drop: ${product.name} is now ${fmt(current)}`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
      <h2 style="font-size:20px;margin:0 0 8px">Good news — the price dropped!</h2>
      <p style="color:#666;margin:0 0 16px">
        <strong>${escapeHtml(product.name)}</strong> just reached your target price.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
        <tr><td style="padding:6px 0;color:#666">Your target</td><td style="padding:6px 0;text-align:right">${fmt(Number(alert.targetPrice))}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Current price</td><td style="padding:6px 0;text-align:right;color:#1a8a3a;font-weight:700">${fmt(current)}</td></tr>
      </table>
      <a href="${productUrl}" style="display:inline-block;background:#e33333;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">View the deal</a>
      <p style="color:#999;font-size:12px;margin:24px 0 0">
        You're receiving this because you set a price alert at BestLooking.Skin.
        <a href="${cancelUrl}" style="color:#999">Cancel this alert</a>.
      </p>
    </div>`;
  const text = [
    `Good news — the price dropped!`,
    `${product.name} just reached your target price.`,
    ``,
    `Your target: ${fmt(Number(alert.targetPrice))}`,
    `Current price: ${fmt(current)}`,
    ``,
    `View the deal: ${productUrl}`,
    ``,
    `Cancel this alert: ${cancelUrl}`,
  ].join('\n');

  return sendBrevoEmail({ to: alert.email, subject, html, text });
}

async function updateAlert(documentId: string, data: Record<string, unknown>) {
  const pruned = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  );
  const res = await fetch(`${STRAPI_URL}/api/commerce-price-alerts/${documentId}`, {
    method: 'PUT',
    headers: strapiHeaders(),
    body: JSON.stringify({ data: pruned }),
  });
  if (!res.ok) {
    console.error(`Failed to update alert ${documentId}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
}

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
