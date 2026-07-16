export const STRAPI_URL = (process.env.STRAPI_URL || 'https://cms.fxnstudio.com').replace(/\/$/, '');
export const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN || '';
export const FAL_KEY = process.env.FAL_KEY || process.env.FAL_API_KEY || '';
export const FAL_BACKGROUND_REMOVAL_MODEL = process.env.FAL_BACKGROUND_REMOVAL_MODEL || 'fal-ai/imageutils/rembg';
export const FAL_BACKGROUND_REMOVAL_ENABLED = process.env.FAL_BACKGROUND_REMOVAL_ENABLED === 'true';

// Brevo (transactional email) — used to notify visitors when a price-alert triggers.
export const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
export const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'alerts@bestlooking.skin';
export const ALERT_FROM_NAME = process.env.ALERT_FROM_NAME || 'BestLooking.Skin';
// Public site base, used to build product + cancel links inside alert emails.
export const ALERT_SITE_URL = (process.env.ALERT_SITE_URL || 'https://bestlooking.skin').replace(/\/$/, '');

export function strapiHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(STRAPI_API_TOKEN ? { Authorization: `Bearer ${STRAPI_API_TOKEN}` } : {}),
  };
}
