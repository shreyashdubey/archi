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
 * Deps: report-shared.ts, rich-email-builder.ts.
 */
import {
  getSecrets, safeNrql, tableHtml, wrapEmail, num, val, type Cell, type NrqlResult,
} from './report-shared'
import {
  barChartPng, lineChartPng, buildMime, sendRich, toCsv, type Series, type InlineImage,
} from './rich-email-builder'

const PAGE_TEMPLATE = 'mf-detail'
const URL_PATTERN = '%/investments/%-growth%'
const SINCE = process.env.DIGEST_PERIOD ?? 'SINCE 1 day ago'

const CRAWL_FILTER = `WHERE pageType = '${PAGE_TEMPLATE}' ${SINCE}` // CrawlPageMetric / CrawlComponentMetric / CrawlApiMetric
const RUM_VITALS_FILTER = `WHERE pageUrl LIKE '${URL_PATTERN}' ${SINCE}` // PageViewTiming

// SLO thresholds for red-flagging cells/bars.
const LIMITS = { renderSuccessPct: 99, renderMs: 800, loadMs: 3000, apiMs: 1500, redirectMs: 2500 }

/** NerdGraph returns facet values under `facet`. */
const facetValue = (queryResultRow: NrqlResult, facetIndex = 0): string => {
  const facetField = (queryResultRow as any).facet
  const isMultiFacet = Array.isArray(facetField)
  return String(isMultiFacet ? facetField[facetIndex] : facetField ?? '—')
}

export const handler = async (): Promise<void> => {
  const secrets = await getSecrets()
  const newRelicApiKey = secrets.NR_API_KEY
  const query = (nrqlQuery: string) => safeNrql(nrqlQuery, newRelicApiKey)

  // --- queries: crawl = complete coverage; RUM = real-user CWV ------------
  const [fleetSummary, realUserVitals, components, renderFailures, slowestPages, perPageRows, apiCalls, ctaRedirects, loadTrend] =
    await Promise.all([
      query(`SELECT uniqueCount(fundSlug) AS pages, average(loadMs) AS avgLoad, percentile(loadMs,75) AS loadP75,
        sum(jsErrors) AS jsErrors FROM CrawlPageMetric ${CRAWL_FILTER}`),
      query(`SELECT percentile(largestContentfulPaint,75) AS lcp, percentile(interactionToNextPaint,75) AS inp
        FROM PageViewTiming ${RUM_VITALS_FILTER}`),
      query(`SELECT percentage(count(*), WHERE status='rendered') AS renderOk, percentile(renderMs,75) AS renderP75,
        filter(count(*), WHERE status='error') AS errors, filter(count(*), WHERE status='missing') AS missing
        FROM CrawlComponentMetric ${CRAWL_FILTER} FACET component LIMIT 50`),
      query(`SELECT count(*) AS failures FROM CrawlComponentMetric
        WHERE pageType='${PAGE_TEMPLATE}' AND status IN ('error','missing') ${SINCE}
        FACET fundSlug, component LIMIT 25`),
      query(`SELECT average(loadMs) AS load FROM CrawlPageMetric ${CRAWL_FILTER} FACET fundSlug LIMIT 100`),
      query(`SELECT average(loadMs) AS load, max(lcp) AS lcp, sum(jsErrors) AS js, latest(httpStatus) AS http
        FROM CrawlPageMetric ${CRAWL_FILTER} FACET fundSlug LIMIT MAX`),
      query(`SELECT percentile(durationMs,95) AS p95, percentage(count(*), WHERE httpStatus>=400) AS errPct,
        count(*) AS calls FROM CrawlApiMetric ${CRAWL_FILTER} FACET endpoint LIMIT 20`),
      query(`SELECT percentile(redirectMs,75) AS p75, percentile(redirectMs,95) AS p95, count(*) AS clicks
        FROM CrawlCtaMetric ${CRAWL_FILTER} FACET cta LIMIT 25`),
      query(`SELECT percentile(loadMs,75) AS load, average(lcp) AS lcp FROM CrawlPageMetric
        WHERE pageType='${PAGE_TEMPLATE}' SINCE 7 days ago TIMESERIES 1 day`),
    ])

  const summaryRow = fleetSummary[0]
  const vitalsRow = realUserVitals[0]

  // --- build the PNG charts (embedded by Content-ID) ---------------------
  const renderLatencyBars: Series[] = components.map((componentRow) => ({
    label: facetValue(componentRow),
    value: Math.round(val(componentRow, 'renderP75')),
    bad: val(componentRow, 'renderP75') > LIMITS.renderMs,
  }))
  const apiBars: Series[] = apiCalls.map((apiCallRow) => ({
    label: facetValue(apiCallRow),
    value: Math.round(val(apiCallRow, 'p95')),
    bad: val(apiCallRow, 'p95') > LIMITS.apiMs,
  }))
  const ctaBars: Series[] = ctaRedirects.map((ctaRedirectRow) => ({
    label: facetValue(ctaRedirectRow),
    value: Math.round(val(ctaRedirectRow, 'p75')),
    bad: val(ctaRedirectRow, 'p75') > LIMITS.redirectMs,
  }))

  const MAX_PAGE_LABEL_LENGTH = 28
  const tenSlowestPages = [...slowestPages]
    .sort((firstPage, secondPage) => val(secondPage, 'load') - val(firstPage, 'load'))
    .slice(0, 10)
  const slowestBars: Series[] = tenSlowestPages.map((pageRow) => ({
    label: facetValue(pageRow).slice(0, MAX_PAGE_LABEL_LENGTH),
    value: Math.round(val(pageRow, 'load')),
    bad: val(pageRow, 'load') > LIMITS.loadMs,
  }))

  // Label each point relative to today: oldest day is "D-6", today is "D-0".
  const lastTrendDayIndex = loadTrend.length - 1
  const trendDayLabels = loadTrend.map((_, dayIndex) => `D-${lastTrendDayIndex - dayIndex}`)
  const chartImages: InlineImage[] = [
    {
      cid: 'trend',
      png: await lineChartPng('7-day fleet trend (ms)', trendDayLabels, [
        { label: 'load p75', points: loadTrend.map((trendDayRow) => Math.round(val(trendDayRow, 'load'))) },
        { label: 'LCP', points: loadTrend.map((trendDayRow) => Math.round(val(trendDayRow, 'lcp'))) },
      ]),
    },
    { cid: 'renderLatency', png: await barChartPng('Component render p75 (ms)', renderLatencyBars) },
    { cid: 'api', png: await barChartPng('API p95 (ms)', apiBars, true) },
    { cid: 'slowest', png: await barChartPng('Top 10 slowest pages (ms)', slowestBars, true) },
    { cid: 'cta', png: await barChartPng('CTA redirect p75 (ms)', ctaBars, true) },
  ]

  // --- HTML body: charts (cid images) + every table ----------------------
  const chartImg = (contentId: string, altText: string) =>
    `<img src="cid:${contentId}" width="700" alt="${altText}" style="max-width:100%;border:1px solid #eee;border-radius:6px;margin:8px 0">`
  const chartsHtml =
    chartImg('trend', '7-day trend') +
    chartImg('renderLatency', 'Component render latency') +
    chartImg('api', 'API p95') +
    chartImg('slowest', 'Top slowest pages') +
    chartImg('cta', 'CTA redirect')

  const fleetSummaryTable = tableHtml('Fleet summary', ['Metric', 'Value'], [
    [{ v: 'Pages crawled (all)' }, { v: num(summaryRow, 'pages') }],
    [{ v: 'Avg load (ms)' }, { v: num(summaryRow, 'avgLoad') }],
    [{ v: 'Load p75 (ms)' }, { v: num(summaryRow, 'loadP75'), bad: val(summaryRow, 'loadP75') > LIMITS.loadMs }],
    [{ v: 'LCP p75 (RUM, ms)' }, { v: num(vitalsRow, 'lcp'), bad: val(vitalsRow, 'lcp') > 2500 }],
    [{ v: 'JS errors' }, { v: num(summaryRow, 'jsErrors'), bad: val(summaryRow, 'jsErrors') > 0 }],
  ])

  const componentTable = tableHtml(
    'Component health — rendered? & latency (all pages)',
    ['Component', 'Render success', 'Render p75', 'Errors', 'Missing'],
    components.map((componentRow): Cell[] => [
      { v: facetValue(componentRow) },
      { v: num(componentRow, 'renderOk', 1) + '%', bad: val(componentRow, 'renderOk') < LIMITS.renderSuccessPct },
      { v: num(componentRow, 'renderP75') + ' ms', bad: val(componentRow, 'renderP75') > LIMITS.renderMs },
      { v: num(componentRow, 'errors'), bad: val(componentRow, 'errors') > 0 },
      { v: num(componentRow, 'missing'), bad: val(componentRow, 'missing') > 0 },
    ]),
  )

  const slowestPagesTable = tableHtml(
    'Top 10 slowest pages — load',
    ['Fund slug', 'Load'],
    tenSlowestPages.map((pageRow): Cell[] => [
      { v: facetValue(pageRow) },
      { v: num(pageRow, 'load') + ' ms', bad: val(pageRow, 'load') > LIMITS.loadMs },
    ]),
  )

  const renderFailuresTable = tableHtml(
    'Top render failures (error / missing)',
    ['Fund slug', 'Component', 'Failures'],
    renderFailures.map((failureRow): Cell[] => [
      { v: facetValue(failureRow, 0) },
      { v: facetValue(failureRow, 1) },
      { v: num(failureRow, 'failures'), bad: true },
    ]),
  )

  const apiTable = tableHtml(
    'API performance',
    ['Endpoint', 'p95', 'Error %', 'Calls'],
    apiCalls.map((apiCallRow): Cell[] => [
      { v: facetValue(apiCallRow) },
      { v: num(apiCallRow, 'p95') + ' ms', bad: val(apiCallRow, 'p95') > LIMITS.apiMs },
      { v: num(apiCallRow, 'errPct', 1) + '%', bad: val(apiCallRow, 'errPct') > 0 },
      { v: num(apiCallRow, 'calls') },
    ]),
  )

  const ctaTable = tableHtml(
    'CTA → redirect timing',
    ['CTA', 'Redirect p75', 'Redirect p95', 'Clicks'],
    ctaRedirects.map((ctaRedirectRow): Cell[] => [
      { v: facetValue(ctaRedirectRow) },
      { v: num(ctaRedirectRow, 'p75') + ' ms', bad: val(ctaRedirectRow, 'p75') > LIMITS.redirectMs },
      { v: num(ctaRedirectRow, 'p95') + ' ms' },
      { v: num(ctaRedirectRow, 'clicks') },
    ]),
  )

  const reportingPeriodLabel = SINCE.replace('SINCE ', '') // e.g. "1 day ago"
  const csvFileName = `fleet-${process.env.REPORT_DATE ?? 'latest'}.csv`

  // Coverage honesty: the per-page rows come from `FACET fundSlug LIMIT MAX`, which
  // NerdGraph caps (~10k facets). Distinguish two cases so the banner doesn't
  // mis-blame the cap: (a) the per-page query degraded to [] (safeNrql) while the
  // cheap summary succeeded → a query error, not a cap; (b) it returned some but
  // fewer rows than pages → a real FACET-cap truncation (export from S3).
  const pagesCrawled = val(summaryRow, 'pages')
  const perPageDegraded = pagesCrawled > 0 && perPageRows.length === 0
  const perPageTruncated = pagesCrawled > 0 && perPageRows.length > 0 && perPageRows.length < pagesCrawled
  let coverageText = `${num(summaryRow, 'pages')} pages crawled (active)`
  if (perPageDegraded) {
    console.warn(`Per-page query returned no rows for ${pagesCrawled} pages — likely a NerdGraph error (degraded mode).`)
    coverageText = `per-page CSV unavailable (per-page query failed; the aggregates above are unaffected)`
  } else if (perPageTruncated) {
    console.warn(`Per-page CSV truncated: ${perPageRows.length} of ${pagesCrawled} pages (NRQL FACET cap).`)
    coverageText = `${perPageRows.length} of ${num(summaryRow, 'pages')} pages in CSV (NRQL FACET cap — export the full set from the crawler's S3 output)`
  }

  // One consolidated email via the shared shell: coverage banner + CSV-attachment
  // button + dashboard CTA, wrapping the charts and every table.
  const html = wrapEmail(
    '📊 Daily fund-page fleet report — /investments/*-growth',
    `Template-wide health for ${reportingPeriodLabel}.`,
    chartsHtml + fleetSummaryTable + componentTable + slowestPagesTable + renderFailuresTable + apiTable + ctaTable,
    secrets.NR_DASHBOARD_URL ?? 'https://one.newrelic.com',
    'Open fleet dashboard →',
    { coverage: coverageText, csvAttachmentName: csvFileName },
  )

  // --- per-page CSV (one row per slug) -----------------------------------
  const perPageCsv = toCsv(
    ['fundSlug', 'avg_load_ms', 'lcp_ms', 'js_errors', 'http_status'],
    perPageRows.map((perPageRow) => [
      facetValue(perPageRow),
      num(perPageRow, 'load'),
      num(perPageRow, 'lcp'),
      num(perPageRow, 'js'),
      num(perPageRow, 'http'),
    ]),
  )

  // --- assemble MIME (HTML + inline charts + CSV) and send via SES -------
  const mimeMessage = buildMime({
    from: secrets.SES_FROM,
    to: secrets.DIGEST_RECIPIENTS.split(','),
    subject: `Fleet digest: /investments/*-growth — ${num(summaryRow, 'pages')} pages, ${num(summaryRow, 'jsErrors')} JS errors`,
    html,
    images: chartImages,
    csv: { filename: csvFileName, content: perPageCsv },
  })
  await sendRich(mimeMessage)
}
