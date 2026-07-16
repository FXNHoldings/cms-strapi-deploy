import { ALERT_FROM_EMAIL, ALERT_FROM_NAME, BREVO_API_KEY } from './config';

/**
 * Send a transactional email via Brevo's HTTP API.
 * https://developers.brevo.com/reference/sendtransacemail
 *
 * Multi-domain: the `from` address just has to belong to a domain you've
 * authenticated in Brevo (Senders & Domains). Pass `from` to override the
 * default sender per site.
 */
export async function sendBrevoEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: { email: string; name?: string };
  replyTo?: { email: string; name?: string };
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!BREVO_API_KEY) {
    return { ok: false, error: 'BREVO_API_KEY is not configured.' };
  }

  const sender = opts.from ?? { email: ALERT_FROM_EMAIL, name: ALERT_FROM_NAME };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': BREVO_API_KEY,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: opts.to }],
      subject: opts.subject,
      htmlContent: opts.html,
      ...(opts.text ? { textContent: opts.text } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `Brevo send failed: HTTP ${res.status} ${body}` };
  }

  const json = await res.json().catch(() => ({}));
  return { ok: true, messageId: json?.messageId };
}
