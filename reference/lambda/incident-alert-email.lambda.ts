/**
 * Event-driven Lambda: a New Relic alert workflow webhook → an enriched email.
 * Trigger: Lambda Function URL (or API Gateway), with an HMAC-signed body.
 *
 * Monitored page: ONE critical fund at the URL pattern /investments/{slug}-growth
 * (default: the Nippon fund). All NRQL is filtered by that URL.
 *
 * Flow:
 *   1. verify the webhook HMAC signature
 *   2. parse the incident payload
 *   3. enrich it via NerdGraph (metrics for the incident window)
 *   4. render an HTML email and send it via SES
 *   5. failures bubble up → async retry → SQS DLQ
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda'
import {
  getSecrets,
  verifySignature,
  safeNrql,
  renderHtml,
  sendEmail,
  num,
  type ReportSection,
} from './shared-nerdgraph-email-utils'

/** Shape of the New Relic workflow webhook payload (configured in the workflow). */
interface NewRelicIncident {
  issueId: string
  title: string
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  state: 'ACTIVATED' | 'CLOSED'
  issueUrl: string
  createdAt?: number
}

// The single page this Lambda reports on, identified purely by its URL path.
const MONITORED_PAGE_PATH = process.env.MONITORED_PAGE_PATH ?? '/investments/nippon-india-taiwan-equity-fund-g-growth'
const SYNTHETIC_MONITOR_NAME = process.env.SYNTHETIC_MONITOR_NAME ?? 'investments-nippon-taiwan-growth-monitor'

// Reusable NRQL fragments that pin every query to this one URL.
const SERVER_URL_FILTER = `request.uri LIKE '%${MONITORED_PAGE_PATH}%'`
const BROWSER_URL_FILTER = `pageUrl LIKE '%${MONITORED_PAGE_PATH}%'`
const INCIDENT_WINDOW = 'SINCE 30 minutes ago'

export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  const secrets = await getSecrets()
  const rawBody = event.body ?? ''
  const signature = event.headers?.['x-nr-signature'] ?? event.headers?.['X-NR-Signature'] ?? ''

  // 1. Reject anything not signed with our shared secret.
  if (!verifySignature(rawBody, signature, secrets.WEBHOOK_HMAC_SECRET)) {
    console.warn('Rejected webhook: invalid signature')
    return { statusCode: 401, body: 'invalid signature' }
  }

  // 2. Parse the incident; closed incidents get a short "resolved" email.
  const incident = JSON.parse(rawBody) as NewRelicIncident
  if (incident.state === 'CLOSED') {
    await sendResolvedEmail(incident, secrets)
    return { statusCode: 200, body: 'resolved-ack' }
  }

  // 3. Enrich (best-effort: the email still sends even if a query fails).
  const apiKey = secrets.NR_API_KEY
  const [serverMetrics, coreWebVitals, topErrors, failingLocations] = await Promise.all([
    safeNrql(
      `SELECT percentile(duration,95) AS p95, percentage(count(*), WHERE error IS true) AS errorPct,
        apdex(duration, t:0.5) AS apdex FROM Transaction WHERE ${SERVER_URL_FILTER} ${INCIDENT_WINDOW}`,
      apiKey,
    ),
    safeNrql(
      `SELECT percentile(largestContentfulPaint,75) AS lcp, percentile(interactionToNextPaint,75) AS inp
        FROM PageViewTiming WHERE ${BROWSER_URL_FILTER} ${INCIDENT_WINDOW}`,
      apiKey,
    ),
    safeNrql(
      `SELECT count(*) FROM TransactionError WHERE ${SERVER_URL_FILTER}
        FACET error.message ${INCIDENT_WINDOW} LIMIT 5`,
      apiKey,
    ),
    safeNrql(
      `SELECT count(*) FROM SyntheticCheck WHERE monitorName = '${SYNTHETIC_MONITOR_NAME}'
        AND result = 'FAILED' FACET locationLabel ${INCIDENT_WINDOW}`,
      apiKey,
    ),
  ])

  const server = serverMetrics[0]
  const vitals = coreWebVitals[0]

  const sections: ReportSection[] = [
    {
      heading: 'Server (APM)',
      rows: [
        { label: 'p95 latency (ms)', value: num(server, 'p95'), bad: Number(server?.p95) > 2000 },
        { label: 'Error rate (%)', value: num(server, 'errorPct', 1), bad: Number(server?.errorPct) > 5 },
        { label: 'Apdex', value: num(server, 'apdex', 2), bad: Number(server?.apdex) < 0.85 },
      ],
    },
    {
      heading: 'Real users (Core Web Vitals)',
      rows: [
        { label: 'LCP p75 (s)', value: num(vitals, 'lcp', 2), bad: Number(vitals?.lcp) > 2.5 },
        { label: 'INP p75 (ms)', value: num(vitals, 'inp'), bad: Number(vitals?.inp) > 200 },
      ],
    },
    {
      heading: 'Top errors',
      rows: topErrors.length
        ? topErrors.map((row) => ({ label: String(row['error.message'] ?? '—'), value: num(row, 'count') }))
        : [{ label: 'No errors captured', value: '0' }],
    },
    {
      heading: 'Failing synthetic locations',
      rows: failingLocations.length
        ? failingLocations.map((row) => ({ label: String(row.locationLabel ?? '—'), value: num(row, 'count'), bad: true }))
        : [{ label: 'No synthetic failures', value: '0' }],
    },
  ]

  // 4. Render + send.
  const html = renderHtml(
    `🚨 ${incident.priority}: ${MONITORED_PAGE_PATH} — ${incident.title}`,
    `New Relic incident <code>${incident.issueId}</code> opened. Metrics for the last 30 minutes:`,
    sections,
    incident.issueUrl,
  )
  await sendEmail({
    from: secrets.SES_FROM,
    to: secrets.ALERT_RECIPIENTS.split(','),
    subject: `[${incident.priority}] ${MONITORED_PAGE_PATH} degraded — ${incident.title}`,
    html,
  })

  return { statusCode: 200, body: 'sent' }
}

/** Short "all clear" email when the incident closes. */
async function sendResolvedEmail(incident: NewRelicIncident, secrets: Record<string, string>) {
  await sendEmail({
    from: secrets.SES_FROM,
    to: secrets.ALERT_RECIPIENTS.split(','),
    subject: `[RESOLVED] ${MONITORED_PAGE_PATH} — ${incident.title}`,
    html: renderHtml(
      `✅ Resolved: ${MONITORED_PAGE_PATH}`,
      `Incident <code>${incident.issueId}</code> is now closed.`,
      [],
      incident.issueUrl,
    ),
  })
}
