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
} from './shared-nerdgraph-email-utils'

// What "the fleet" means, expressed two equivalent ways.
const URL_PATTERN = '%/investments/%-growth%' // matches the monitored URLs
const PAGE_TEMPLATE = 'mf-detail' // the attribute set on custom events for this template
const SINCE = process.env.DIGEST_PERIOD ?? 'SINCE 1 day ago'

const BROWSER_FILTER = `pageUrl LIKE '${URL_PATTERN}' ${SINCE}` // PageView / PageViewTiming / Ajax / JsError
const ACTION_FILTER = `pageType = '${PAGE_TEMPLATE}'` // PageAction (ComponentRender / CtaRedirect)

// SLO thresholds used to flag a cell red in the email.
const LIMITS = { renderSuccessPct: 99, renderMs: 800, loadS: 3, apiMs: 1500, apiErrPct: 2, redirectMs: 2500 }

/** NerdGraph returns facet values under `facet` (string, or array for multi-facet). */
const facetValue = (row: NrqlResult, position = 0): string => {
  const facet = (row as any).facet
  return String(Array.isArray(facet) ? facet[position] : facet ?? '—')
}

export const handler = async (): Promise<void> => {
  const secrets = await getSecrets()
  const apiKey = secrets.NR_API_KEY
  const query = (nrql: string) => safeNrql(nrql, apiKey)

  // Fire every section's query in parallel.
  const [summary, coreWebVitals, jsErrors, components, pages, renderFailures, apiCalls, ctaRedirects, synthetic] =
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
      query(`SELECT percentage(count(*), WHERE result='SUCCESS') AS successPct,
        filter(count(*), WHERE result='FAILED') AS failed, uniqueCount(custom.checkedSlug) AS checked
        FROM SyntheticCheck WHERE monitorName LIKE 'investments-growth-%' ${SINCE}`),
    ])

  const summaryRow = summary[0]
  const vitalsRow = coreWebVitals[0]
  const syntheticRow = synthetic[0]

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
    components.map((row): Cell[] => [
      { v: facetValue(row) },
      { v: num(row, 'renderOk', 1) + '%', bad: val(row, 'renderOk') < LIMITS.renderSuccessPct },
      { v: num(row, 'renderP75') + ' ms', bad: val(row, 'renderP75') > LIMITS.renderMs },
      { v: num(row, 'errors'), bad: val(row, 'errors') > 0 },
      { v: num(row, 'missing'), bad: val(row, 'missing') > 0 },
    ]),
  )

  // -- Section 3: top 10 slowest pages (sorted here, not in NRQL) ----------
  const slowestPagesTable = tableHtml(
    'Top 10 slowest pages',
    ['Fund slug', 'Load p75', 'Views'],
    [...pages]
      .sort((a, b) => val(b, 'loadP75') - val(a, 'loadP75'))
      .slice(0, 10)
      .map((row): Cell[] => [
        { v: facetValue(row) },
        { v: num(row, 'loadP75', 2) + ' s', bad: val(row, 'loadP75') > LIMITS.loadS },
        { v: num(row, 'views') },
      ]),
  )

  // -- Section 4: top render failures (slug × component) ------------------
  const renderFailuresTable = tableHtml(
    'Top render failures (error / missing)',
    ['Fund slug', 'Component', 'Failures'],
    renderFailures.map((row): Cell[] => [
      { v: facetValue(row, 0) },
      { v: facetValue(row, 1) },
      { v: num(row, 'failures'), bad: true },
    ]),
  )

  // -- Section 5: API performance ----------------------------------------
  const apiTable = tableHtml(
    'API performance',
    ['Endpoint', 'p95', 'Error %', 'Calls'],
    apiCalls.map((row): Cell[] => [
      { v: facetValue(row) },
      { v: num(row, 'p95') + ' ms', bad: val(row, 'p95') > LIMITS.apiMs },
      { v: num(row, 'errPct', 1) + '%', bad: val(row, 'errPct') > LIMITS.apiErrPct },
      { v: num(row, 'calls') },
    ]),
  )

  // -- Section 6: CTA → redirect timing ----------------------------------
  const ctaTable = tableHtml(
    'CTA → redirect timing',
    ['CTA', 'Redirect p75', 'Redirect p95', 'Clicks'],
    ctaRedirects.map((row): Cell[] => [
      { v: facetValue(row) },
      { v: num(row, 'p75') + ' ms', bad: val(row, 'p75') > LIMITS.redirectMs },
      { v: num(row, 'p95') + ' ms' },
      { v: num(row, 'clicks') },
    ]),
  )

  // -- Section 7: synthetic coverage of the long tail ---------------------
  const syntheticTable = tableHtml('Synthetic coverage (long tail)', ['Metric', 'Value'], [
    [{ v: 'Unique slugs checked' }, { v: num(syntheticRow, 'checked') }],
    [{ v: 'Success %' }, { v: num(syntheticRow, 'successPct', 2) + '%', bad: val(syntheticRow, 'successPct') < 99 }],
    [{ v: 'Failed checks' }, { v: num(syntheticRow, 'failed'), bad: val(syntheticRow, 'failed') > 0 }],
  ])

  const html = wrapEmail(
    `📊 Daily fund-page fleet report — /investments/*-growth`,
    `Template-wide health across ${num(summaryRow, 'pages')} pages for ${SINCE.replace('SINCE ', '')}.`,
    summaryTable + componentTable + slowestPagesTable + renderFailuresTable + apiTable + ctaTable + syntheticTable,
    secrets.NR_DASHBOARD_URL ?? 'https://one.newrelic.com',
    'Open fleet dashboard →',
  )

  await sendEmail({
    from: secrets.SES_FROM,
    to: secrets.DIGEST_RECIPIENTS.split(','),
    subject: `Fleet digest: /investments/*-growth — ${num(summaryRow, 'pages')} pages, ${num(jsErrors[0], 'errors')} JS errors`,
    html,
  })
}
