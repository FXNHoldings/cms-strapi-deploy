'use strict';

const DEFAULT_BASE_URL = 'https://api.admitad.com';
const DEFAULT_WINDOW_DAYS = 30;

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatReportDate(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function numberish(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function addMoney(target, row) {
  target.paymentSum += numberish(row.payment_sum);
  target.paymentOpen += numberish(row.payment_sum_open);
  target.paymentApproved += numberish(row.payment_sum_approved);
  target.paymentDeclined += numberish(row.payment_sum_declined);
}

function totalsFromRows(rows) {
  const total = {
    clicks: 0,
    actions: 0,
    leads: 0,
    sales: 0,
    paymentSum: 0,
    paymentOpen: 0,
    paymentApproved: 0,
    paymentDeclined: 0,
    currency: null,
  };

  for (const row of rows) {
    total.clicks += numberish(row.clicks);
    total.actions += numberish(row.actions_sum_total ?? row.actions ?? row.action);
    total.leads += numberish(row.leads_sum ?? row.leads);
    total.sales += numberish(row.sales_sum ?? row.sales);
    if (!total.currency && row.currency) total.currency = row.currency;
    addMoney(total, row);
  }

  return total;
}

function normalizeRow(row, labelField, fallbackLabel) {
  return {
    label: row[labelField] ?? row.name ?? row.source_name ?? row.source ?? row.subid ?? row.date ?? fallbackLabel,
    clicks: numberish(row.clicks),
    actions: numberish(row.actions_sum_total ?? row.actions ?? row.action),
    leads: numberish(row.leads_sum ?? row.leads),
    sales: numberish(row.sales_sum ?? row.sales),
    paymentSum: numberish(row.payment_sum),
    paymentOpen: numberish(row.payment_sum_open),
    paymentApproved: numberish(row.payment_sum_approved),
    paymentDeclined: numberish(row.payment_sum_declined),
    currency: row.currency ?? null,
  };
}

async function readSite(strapi, siteSlug) {
  const [site] = await strapi.documents('api::commerce-site.commerce-site').findMany({
    filters: { slug: siteSlug },
    fields: ['slug', 'name', 'domain', 'currency'],
    limit: 1,
  });
  return site ?? null;
}

function token() {
  return process.env.TAKEADS_REPORTING_ACCESS_TOKEN
    || process.env.TAKEADS_STATS_ACCESS_TOKEN
    || '';
}

async function fetchReport({ endpoint, params }) {
  const accessToken = token();
  if (!accessToken) {
    return { configured: false, rows: [], error: 'TAKEADS_REPORTING_ACCESS_TOKEN is not configured.' };
  }

  const baseUrl = process.env.TAKEADS_REPORTING_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(`/statistics/${endpoint}/`, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.append(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      configured: true,
      rows: [],
      error: `Takeads report failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
    };
  }

  const json = await response.json();
  const rows = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : [];
  return { configured: true, rows, error: null };
}

module.exports = ({ strapi }) => ({
  async summary(siteSlug, options = {}) {
    const site = await readSite(strapi, siteSlug);
    if (!site) return null;

    const windowDays = Math.max(1, Math.min(365, Number(options.windowDays || DEFAULT_WINDOW_DAYS)));
    const end = new Date();
    const start = new Date(Date.now() - (windowDays - 1) * 86_400_000);
    const common = {
      date_start: formatReportDate(start),
      date_end: formatReportDate(end),
      limit: 10,
      offset: 0,
    };

    const [daily, campaigns, subids] = await Promise.all([
      fetchReport({ endpoint: 'dates', params: { ...common, order_by: 'date' } }),
      fetchReport({ endpoint: 'campaigns', params: { ...common, order_by: '-payment_sum' } }),
      fetchReport({ endpoint: 'sub_ids', params: { ...common, order_by: '-payment_sum' } }),
    ]);

    const errors = [daily.error, campaigns.error, subids.error].filter(Boolean);
    const configured = daily.configured || campaigns.configured || subids.configured;

    return {
      site: {
        slug: site.slug,
        name: site.name,
        domain: site.domain,
        currency: site.currency ?? null,
      },
      configured,
      windowDays,
      dateStart: start.toISOString().slice(0, 10),
      dateEnd: end.toISOString().slice(0, 10),
      totals: totalsFromRows(daily.rows),
      daily: daily.rows.map((row) => normalizeRow(row, 'date', 'day')),
      campaigns: campaigns.rows.map((row) => normalizeRow(row, 'advcampaign_name', 'campaign')),
      subids: subids.rows.map((row) => normalizeRow(row, 'subid', 'subid')),
      errors,
    };
  },
});
