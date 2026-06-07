/**
 * Scheduled Lambda: a daily/weekly SLA digest for ONE critical fund page.
 * Trigger: EventBridge Scheduler (cron). No webhook, no signature.
 *
 * Monitored page: /investments/{slug}-growth (default: the Nippon fund),
 * identified purely by its URL pattern in every query.
 */
import {
  getSecrets,
  safeNrql,
  renderHtml,
  sendEmail,
  num,
  type ReportSection,
} from './report-shared'

const MONITORED_PAGE_PATH = process.env.MONITORED_PAGE_PATH ?? '/investments/nippon-india-taiwan-equity-fund-g-growth'
const SYNTHETIC_MONITOR_NAME = process.env.SYNTHETIC_MONITOR_NAME ?? 'investments-nippon-taiwan-growth-monitor'
const REPORTING_PERIOD = process.env.DIGEST_PERIOD ?? 'SINCE 1 day ago' // or 'SINCE 1 week ago'

const SERVER_URL_FILTER = `request.uri LIKE '%${MONITORED_PAGE_PATH}%'`
const BROWSER_URL_FILTER = `pageUrl LIKE '%${MONITORED_PAGE_PATH}%'`

export const handler = async (): Promise<void> => {
  const secrets = await getSecrets()
  const apiKey = secrets.NR_API_KEY

  // Pull the headline numbers in parallel. Each query returns an array of rows.
  const [uptimeRows, serverMetricRows, coreWebVitalRows, syntheticFailureRows] = await Promise.all([
    safeNrql(
      `SELECT percentage(count(*), WHERE result='SUCCESS') AS uptime
        FROM SyntheticCheck WHERE monitorName = '${SYNTHETIC_MONITOR_NAME}' ${REPORTING_PERIOD}`,
      apiKey,
    ),
    safeNrql(
      `SELECT percentile(duration,95) AS p95, percentage(count(*), WHERE error IS true) AS errorPct,
        apdex(duration, t:0.5) AS apdex, count(*) AS throughput
        FROM Transaction WHERE ${SERVER_URL_FILTER} ${REPORTING_PERIOD}`,
      apiKey,
    ),
    safeNrql(
      `SELECT percentile(largestContentfulPaint,75) AS lcp, percentile(interactionToNextPaint,75) AS inp
        FROM PageViewTiming WHERE ${BROWSER_URL_FILTER} ${REPORTING_PERIOD}`,
      apiKey,
    ),
    safeNrql(
      `SELECT count(*) AS failures FROM SyntheticCheck
        WHERE monitorName = '${SYNTHETIC_MONITOR_NAME}' AND result='FAILED' ${REPORTING_PERIOD}`,
      apiKey,
    ),
  ])

  // Each query is a single-row aggregate, so we only care about the first row.
  const uptimeMetrics = uptimeRows[0]
  const serverMetrics = serverMetricRows[0]
  const coreWebVitals = coreWebVitalRows[0]
  const syntheticFailureMetrics = syntheticFailureRows[0]
  const uptimePercentage = Number(uptimeMetrics?.uptime ?? 0)

  const sections: ReportSection[] = [
    {
      heading: 'Availability',
      rows: [
        { label: 'Uptime (%)', value: num(uptimeMetrics, 'uptime', 3), bad: uptimePercentage < 99.9 },
        { label: 'Failed synthetic checks', value: num(syntheticFailureMetrics, 'failures'), bad: Number(syntheticFailureMetrics?.failures) > 0 },
        { label: 'Requests served', value: num(serverMetrics, 'throughput') },
      ],
    },
    {
      heading: 'Performance',
      rows: [
        { label: 'p95 latency (ms)', value: num(serverMetrics, 'p95'), bad: Number(serverMetrics?.p95) > 2000 },
        { label: 'Error rate (%)', value: num(serverMetrics, 'errorPct', 2), bad: Number(serverMetrics?.errorPct) > 1 },
        { label: 'Apdex', value: num(serverMetrics, 'apdex', 2), bad: Number(serverMetrics?.apdex) < 0.9 },
        { label: 'LCP p75 (s)', value: num(coreWebVitals, 'lcp', 2), bad: Number(coreWebVitals?.lcp) > 2.5 },
        { label: 'INP p75 (ms)', value: num(coreWebVitals, 'inp'), bad: Number(coreWebVitals?.inp) > 200 },
      ],
    },
  ]

  const html = renderHtml(
    `📊 Daily health digest: ${MONITORED_PAGE_PATH}`,
    `Summary for the reporting period (${REPORTING_PERIOD.replace('SINCE ', '')}).`,
    sections,
    secrets.NR_DASHBOARD_URL ?? 'https://one.newrelic.com',
  )

  await sendEmail({
    from: secrets.SES_FROM,
    to: secrets.DIGEST_RECIPIENTS.split(','),
    subject: `Digest: ${MONITORED_PAGE_PATH} — uptime ${uptimePercentage.toFixed(2)}%`,
    html,
  })
}
