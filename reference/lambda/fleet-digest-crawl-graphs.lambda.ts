/**
 * Production daily digest: crawl-based (every page) + RUM, WITH graphs and a
 * full per-page CSV. Trigger: EventBridge cron, after the nightly crawl finishes.
 *
 * Monitored surface: /investments/{slug}-growth.
 *   - Crawl events (CrawlPageMetric/Component/Api) carry pageType='mf-detail',
 *     which the crawler sets for exactly these URLs → complete coverage.
 *   - Real-user Core Web Vitals come from PageViewTiming filtered by pageUrl.
 *
 * Pipeline: NRQL → HTML tables + PNG charts + CSV → multipart MIME → SES.
 *
 * Deps: shared-nerdgraph-email-utils.ts, email-charts-mime-builder.ts.
 */
import {
  getSecrets, safeNrql, tableHtml, num, val, type Cell, type NrqlResult,
} from './shared-nerdgraph-email-utils'
import {
  barChartPng, lineChartPng, buildMime, sendRich, toCsv, type Series, type InlineImage,
} from './email-charts-mime-builder'

const PAGE_TEMPLATE = 'mf-detail'
const URL_PATTERN = '%/investments/%-growth%'
const SINCE = process.env.DIGEST_PERIOD ?? 'SINCE 1 day ago'

const CRAWL_FILTER = `WHERE pageType = '${PAGE_TEMPLATE}' ${SINCE}` // CrawlPageMetric / CrawlComponentMetric / CrawlApiMetric
const RUM_VITALS_FILTER = `WHERE pageUrl LIKE '${URL_PATTERN}' ${SINCE}` // PageViewTiming

// SLO thresholds for red-flagging cells/bars.
const LIMITS = { renderSuccessPct: 99, renderMs: 800, loadMs: 3000, apiMs: 1500, redirectMs: 2500 }

/** NerdGraph returns facet values under `facet`. */
const facetValue = (row: NrqlResult, position = 0): string => {
  const facet = (row as any).facet
  return String(Array.isArray(facet) ? facet[position] : facet ?? '—')
}

export const handler = async (): Promise<void> => {
  const secrets = await getSecrets()
  const apiKey = secrets.NR_API_KEY
  const query = (nrql: string) => safeNrql(nrql, apiKey)

  // --- queries: crawl = complete coverage; RUM = real-user CWV ------------
  const [fleetSummary, realUserVitals, components, slowestPages, perPageRows, apiCalls, ctaRedirects, loadTrend] =
    await Promise.all([
      query(`SELECT uniqueCount(fundSlug) AS pages, average(loadMs) AS avgLoad, percentile(loadMs,75) AS loadP75,
        sum(jsErrors) AS jsErrors FROM CrawlPageMetric ${CRAWL_FILTER}`),
      query(`SELECT percentile(largestContentfulPaint,75) AS lcp, percentile(interactionToNextPaint,75) AS inp
        FROM PageViewTiming ${RUM_VITALS_FILTER}`),
      query(`SELECT percentage(count(*), WHERE status='rendered') AS renderOk, percentile(renderMs,75) AS renderP75,
        filter(count(*), WHERE status='error') AS errors, filter(count(*), WHERE status='missing') AS missing
        FROM CrawlComponentMetric ${CRAWL_FILTER} FACET component LIMIT 50`),
      query(`SELECT average(loadMs) AS load FROM CrawlPageMetric ${CRAWL_FILTER} FACET fundSlug LIMIT 100`),
      query(`SELECT average(loadMs) AS load, max(lcp) AS lcp, sum(jsErrors) AS js, latest(httpStatus) AS http
        FROM CrawlPageMetric ${CRAWL_FILTER} FACET fundSlug LIMIT MAX`),
      query(`SELECT percentile(durationMs,95) AS p95, percentage(count(*), WHERE httpStatus>=400) AS errPct,
        count(*) AS calls FROM CrawlApiMetric ${CRAWL_FILTER} FACET endpoint LIMIT 20`),
      query(`SELECT percentile(redirectMs,75) AS p75 FROM CrawlCtaMetric ${CRAWL_FILTER} FACET cta LIMIT 25`),
      query(`SELECT percentile(loadMs,75) AS load, average(lcp) AS lcp FROM CrawlPageMetric
        WHERE pageType='${PAGE_TEMPLATE}' SINCE 7 days ago TIMESERIES 1 day`),
    ])

  const summaryRow = fleetSummary[0]
  const vitalsRow = realUserVitals[0]

  // --- build the PNG charts (embedded by Content-ID) ---------------------
  const renderLatencyBars: Series[] = components.map((row) => ({
    label: facetValue(row), value: Math.round(val(row, 'renderP75')), bad: val(row, 'renderP75') > LIMITS.renderMs,
  }))
  const apiBars: Series[] = apiCalls.map((row) => ({
    label: facetValue(row), value: Math.round(val(row, 'p95')), bad: val(row, 'p95') > LIMITS.apiMs,
  }))
  const ctaBars: Series[] = ctaRedirects.map((row) => ({
    label: facetValue(row), value: Math.round(val(row, 'p75')), bad: val(row, 'p75') > LIMITS.redirectMs,
  }))
  const slowestBars: Series[] = [...slowestPages]
    .sort((a, b) => val(b, 'load') - val(a, 'load'))
    .slice(0, 10)
    .map((row) => ({ label: facetValue(row).slice(0, 28), value: Math.round(val(row, 'load')), bad: val(row, 'load') > LIMITS.loadMs }))

  const trendDayLabels = loadTrend.map((_, dayIndex) => `D-${loadTrend.length - 1 - dayIndex}`)
  const chartImages: InlineImage[] = [
    {
      cid: 'trend',
      png: await lineChartPng('7-day fleet trend (ms)', trendDayLabels, [
        { label: 'load p75', points: loadTrend.map((row) => Math.round(val(row, 'load'))) },
        { label: 'LCP', points: loadTrend.map((row) => Math.round(val(row, 'lcp'))) },
      ]),
    },
    { cid: 'renderLatency', png: await barChartPng('Component render p75 (ms)', renderLatencyBars) },
    { cid: 'api', png: await barChartPng('API p95 (ms)', apiBars, true) },
    { cid: 'slowest', png: await barChartPng('Top 10 slowest pages (ms)', slowestBars, true) },
    { cid: 'cta', png: await barChartPng('CTA redirect p75 (ms)', ctaBars, true) },
  ]

  // --- HTML body: charts (cid images) + tables ---------------------------
  const chartImg = (cid: string, alt: string) =>
    `<img src="cid:${cid}" width="700" alt="${alt}" style="max-width:100%;border:1px solid #eee;border-radius:6px;margin:8px 0">`

  const componentTable = tableHtml(
    'Component health — rendered? & latency (all pages)',
    ['Component', 'Render success', 'Render p75', 'Errors', 'Missing'],
    components.map((row): Cell[] => [
      { v: facetValue(row) },
      { v: num(row, 'renderOk', 1) + '%', bad: val(row, 'renderOk') < LIMITS.renderSuccessPct },
      { v: num(row, 'renderP75') + ' ms', bad: val(row, 'renderP75') > LIMITS.renderMs },
      { v: num(row, 'errors'), bad: val(row, 'errors') > 0 },
      { v: num(row, 'missing'), bad: val(row, 'missing') > 0 },
    ]),
  )

  const body = `
    <div style="max-width:760px;margin:auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
      <h2 style="margin:0 0 4px;font:700 18px system-ui">📊 Daily fund-page fleet report — /investments/*-growth</h2>
      <p style="margin:0 0 8px;color:#666;font:13px system-ui">Template-wide health for ${SINCE.replace('SINCE ', '')}.</p>
      <div style="background:#eafaf1;border:1px solid #bfe9d2;border-radius:8px;padding:10px 14px;margin-bottom:8px;font:13px system-ui;color:#246b43">
        <b style="color:#1a7a3c">Coverage:</b> ${num(summaryRow, 'pages')} pages crawled (active)
      </div>
      ${chartImg('trend', '7-day trend')}
      ${chartImg('renderLatency', 'Component render latency')}
      ${chartImg('api', 'API p95')}
      ${chartImg('slowest', 'Top slowest pages')}
      ${chartImg('cta', 'CTA redirect')}
      ${tableHtml('Fleet summary', ['Metric', 'Value'], [
        [{ v: 'Pages crawled (all)' }, { v: num(summaryRow, 'pages') }],
        [{ v: 'Avg load (ms)' }, { v: num(summaryRow, 'avgLoad') }],
        [{ v: 'Load p75 (ms)' }, { v: num(summaryRow, 'loadP75'), bad: val(summaryRow, 'loadP75') > LIMITS.loadMs }],
        [{ v: 'LCP p75 (RUM, ms)' }, { v: num(vitalsRow, 'lcp'), bad: val(vitalsRow, 'lcp') > 2500 }],
        [{ v: 'JS errors' }, { v: num(summaryRow, 'jsErrors'), bad: val(summaryRow, 'jsErrors') > 0 }],
      ])}
      ${componentTable}
      <p style="margin:18px 0 0;font:12px system-ui;color:#888">Full per-page matrix for all ${num(summaryRow, 'pages')} pages attached as CSV.</p>
      <p style="margin:18px 0 0"><a href="${secrets.NR_DASHBOARD_URL ?? 'https://one.newrelic.com'}"
        style="display:inline-block;background:#0b6;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font:600 13px system-ui">Open fleet dashboard →</a></p>
    </div>`

  // --- per-page CSV (one row per slug) -----------------------------------
  const perPageCsv = toCsv(
    ['fundSlug', 'avg_load_ms', 'lcp_ms', 'js_errors', 'http_status'],
    perPageRows.map((row) => [facetValue(row), num(row, 'load'), num(row, 'lcp'), num(row, 'js'), num(row, 'http')]),
  )

  // --- assemble MIME (HTML + inline charts + CSV) and send via SES -------
  const mimeMessage = buildMime({
    from: secrets.SES_FROM,
    to: secrets.DIGEST_RECIPIENTS.split(','),
    subject: `Fleet digest: /investments/*-growth — ${num(summaryRow, 'pages')} pages, ${num(summaryRow, 'jsErrors')} JS errors`,
    html: `<div style="background:#f5f6f8;padding:24px">${body}</div>`,
    images: chartImages,
    csv: { filename: `fleet-${process.env.REPORT_DATE ?? 'latest'}.csv`, content: perPageCsv },
  })
  await sendRich(mimeMessage)
}
