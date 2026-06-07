/**
 * Daily fleet digest built from REAL-USER (RUM) telemetry, for the whole
 * fund-detail template. Trigger: EventBridge cron.
 *
 * Monitored surface: every page at the URL pattern /investments/{slug}-growth.
 *   - Page/Ajax events are filtered by pageUrl (the literal URL pattern).
 *   - Custom PageActions (ComponentRender/CtaRedirect) carry the `pageType`
 *     attribute the instrumentation sets for exactly this template.
 *
 * Output: a multi-section HTML email — aggregates + top-N worst offenders,
 * never one row per page.
 */
import {
  getSecrets, safeNrql, tableHtml, wrapEmail, sendEmail, num, val,
  type NrqlResult, type Cell,
} from './report-shared'

// What "the fleet" means, expressed two equivalent ways.
const URL_PATTERN = '%/investments/%-growth%' // matches the monitored URLs
const PAGE_TEMPLATE = 'mf-detail' // the attribute set on custom events for this template
const SINCE = process.env.DIGEST_PERIOD ?? 'SINCE 1 day ago'

const BROWSER_FILTER = `pageUrl LIKE '${URL_PATTERN}' ${SINCE}` // PageView / PageViewTiming / Ajax / JsError
const ACTION_FILTER = `pageType = '${PAGE_TEMPLATE}'` // PageAction (ComponentRender / CtaRedirect)

// SLO thresholds used to flag a cell red in the email.
const LIMITS = { renderSuccessPct: 99, renderMs: 800, loadS: 3, apiMs: 1500, apiErrPct: 2, redirectMs: 2500 }

/** NerdGraph returns facet values under `facet` (string, or array for multi-facet). */
const facetValue = (queryResultRow: NrqlResult, facetIndex = 0): string => {
  const facetField = (queryResultRow as any).facet
  const isMultiFacet = Array.isArray(facetField)
  return String(isMultiFacet ? facetField[facetIndex] : facetField ?? '—')
}

export const handler = async (): Promise<void> => {
  const secrets = await getSecrets()
  const newRelicApiKey = secrets.NR_API_KEY
  const query = (nrqlQuery: string) => safeNrql(nrqlQuery, newRelicApiKey)

  // Fire every section's query in parallel.
  const [
    fleetSummary, coreWebVitals, jsErrors, components, pageLoadTimes,
    renderFailures, apiCalls, ctaRedirects, syntheticChecks,
  ] =
    await Promise.all([
      query(`SELECT uniqueCount(fundSlug) AS pages, count(*) AS views, percentile(duration,75) AS loadP75
        FROM PageView WHERE ${BROWSER_FILTER}`),
      query(`SELECT percentile(largestContentfulPaint,75) AS lcp, percentile(interactionToNextPaint,75) AS inp
        FROM PageViewTiming WHERE ${BROWSER_FILTER}`),
      query(`SELECT count(*) AS errors FROM JavaScriptError WHERE ${BROWSER_FILTER}`),
      query(`SELECT percentage(count(*), WHERE status='rendered') AS renderOk,
        filter(count(*), WHERE status='error') AS errors, filter(count(*), WHERE status='missing') AS missing,
        percentile(renderMs,75) AS renderP75
        FROM PageAction WHERE actionName='ComponentRender' AND ${ACTION_FILTER} ${SINCE} FACET component LIMIT 50`),
      query(`SELECT percentile(duration,75) AS loadP75, count(*) AS views
        FROM PageView WHERE ${BROWSER_FILTER} FACET fundSlug LIMIT 100`),
      query(`SELECT count(*) AS failures FROM PageAction
        WHERE actionName='ComponentRender' AND ${ACTION_FILTER} AND status IN ('error','missing') ${SINCE}
        FACET fundSlug, component LIMIT 25`),
      query(`SELECT percentile(timeToSettle,95) AS p95, percentage(count(*), WHERE httpResponseCode>=400) AS errPct,
        count(*) AS calls FROM AjaxRequest WHERE ${BROWSER_FILTER}
        FACET capture(requestUrl, r'https?://[^/]+(/[^?]*)') AS endpoint LIMIT 20`),
      query(`SELECT percentile(redirectMs,75) AS p75, percentile(redirectMs,95) AS p95, count(*) AS clicks
        FROM PageAction WHERE actionName='CtaRedirect' AND ${ACTION_FILTER} ${SINCE} FACET cta LIMIT 25`),
      // 'rotating%' matches only the fleet sweep monitor(s); it excludes the
      // single-page SIMPLE monitor ('investments-growth-page-monitor'), whose
      // EVERY_MINUTE checks would otherwise dominate the fleet success rate.
      query(`SELECT percentage(count(*), WHERE result='SUCCESS') AS successPct,
        filter(count(*), WHERE result='FAILED') AS failed, uniqueCount(custom.checkedSlug) AS checked
        FROM SyntheticCheck WHERE monitorName LIKE 'investments-growth-rotating%' ${SINCE}`),
    ])

  const summaryRow = fleetSummary[0]
  const vitalsRow = coreWebVitals[0]
  const syntheticRow = syntheticChecks[0]

  // -- Section 1: fleet summary --------------------------------------------
  const summaryTable = tableHtml('Fleet summary', ['Metric', 'Value'], [
    [{ v: 'Pages observed (real users)' }, { v: num(summaryRow, 'pages') }],
    [{ v: 'Pageviews' }, { v: num(summaryRow, 'views') }],
    [{ v: 'Load p75 (s)' }, { v: num(summaryRow, 'loadP75', 2), bad: val(summaryRow, 'loadP75') > LIMITS.loadS }],
    [{ v: 'LCP p75 (s)' }, { v: num(vitalsRow, 'lcp', 2), bad: val(vitalsRow, 'lcp') > 2.5 }],
    [{ v: 'INP p75 (ms)' }, { v: num(vitalsRow, 'inp'), bad: val(vitalsRow, 'inp') > 200 }],
    [{ v: 'JS errors' }, { v: num(jsErrors[0], 'errors'), bad: val(jsErrors[0], 'errors') > 0 }],
  ])

  // -- Section 2: component health (rendered? how fast?) -------------------
  const componentTable = tableHtml(
    'Component health — rendered? & latency',
    ['Component', 'Render success', 'Render p75', 'Errors', 'Missing'],
    components.map((componentRow): Cell[] => [
      { v: facetValue(componentRow) },
      { v: num(componentRow, 'renderOk', 1) + '%', bad: val(componentRow, 'renderOk') < LIMITS.renderSuccessPct },
      { v: num(componentRow, 'renderP75') + ' ms', bad: val(componentRow, 'renderP75') > LIMITS.renderMs },
      { v: num(componentRow, 'errors'), bad: val(componentRow, 'errors') > 0 },
      { v: num(componentRow, 'missing'), bad: val(componentRow, 'missing') > 0 },
    ]),
  )

  // -- Section 3: top 10 slowest pages (sorted here, not in NRQL) ----------
  const tenSlowestPages = [...pageLoadTimes]
    .sort((firstPage, secondPage) => val(secondPage, 'loadP75') - val(firstPage, 'loadP75'))
    .slice(0, 10)
  const slowestPagesTable = tableHtml(
    'Top 10 slowest pages',
    ['Fund slug', 'Load p75', 'Views'],
    tenSlowestPages.map((pageRow): Cell[] => [
      { v: facetValue(pageRow) },
      { v: num(pageRow, 'loadP75', 2) + ' s', bad: val(pageRow, 'loadP75') > LIMITS.loadS },
      { v: num(pageRow, 'views') },
    ]),
  )

  // -- Section 4: top render failures (slug × component) ------------------
  const renderFailuresTable = tableHtml(
    'Top render failures (error / missing)',
    ['Fund slug', 'Component', 'Failures'],
    renderFailures.map((renderFailureRow): Cell[] => [
      { v: facetValue(renderFailureRow, 0) },
      { v: facetValue(renderFailureRow, 1) },
      { v: num(renderFailureRow, 'failures'), bad: true },
    ]),
  )

  // -- Section 5: API performance ----------------------------------------
  const apiTable = tableHtml(
    'API performance',
    ['Endpoint', 'p95', 'Error %', 'Calls'],
    apiCalls.map((apiCallRow): Cell[] => [
      { v: facetValue(apiCallRow) },
      { v: num(apiCallRow, 'p95') + ' ms', bad: val(apiCallRow, 'p95') > LIMITS.apiMs },
      { v: num(apiCallRow, 'errPct', 1) + '%', bad: val(apiCallRow, 'errPct') > LIMITS.apiErrPct },
      { v: num(apiCallRow, 'calls') },
    ]),
  )

  // -- Section 6: CTA → redirect timing ----------------------------------
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

  // -- Section 7: synthetic coverage of the long tail ---------------------
  const syntheticTable = tableHtml('Synthetic coverage (long tail)', ['Metric', 'Value'], [
    [{ v: 'Unique slugs checked' }, { v: num(syntheticRow, 'checked') }],
    [{ v: 'Success %' }, { v: num(syntheticRow, 'successPct', 2) + '%', bad: val(syntheticRow, 'successPct') < 99 }],
    [{ v: 'Failed checks' }, { v: num(syntheticRow, 'failed'), bad: val(syntheticRow, 'failed') > 0 }],
  ])

  const reportingPeriodLabel = SINCE.replace('SINCE ', '') // e.g. "1 day ago"
  const html = wrapEmail(
    `📊 Daily fund-page fleet report — /investments/*-growth`,
    `Template-wide health across ${num(summaryRow, 'pages')} pages for ${reportingPeriodLabel}.`,
    summaryTable + componentTable + slowestPagesTable + renderFailuresTable + apiTable + ctaTable + syntheticTable,
    secrets.NR_DASHBOARD_URL ?? 'https://one.newrelic.com',
    'Open fleet dashboard →',
    { coverage: `${num(summaryRow, 'pages')} pages observed (RUM) · ${num(summaryRow, 'views')} pageviews · ${num(syntheticRow, 'checked')} synthetic slugs` },
  )

  await sendEmail({
    from: secrets.SES_FROM,
    to: secrets.DIGEST_RECIPIENTS.split(','),
    subject: `Fleet digest: /investments/*-growth — ${num(summaryRow, 'pages')} pages, ${num(jsErrors[0], 'errors')} JS errors`,
    html,
  })
}
