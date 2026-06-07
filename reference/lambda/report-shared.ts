/**
 * Shared building blocks used by every report Lambda:
 *   - secrets caching (Secrets Manager)
 *   - NerdGraph (NRQL) client
 *   - HMAC webhook verification
 *   - HTML rendering (key/value sections, multi-column tables, consolidated
 *     email shell: coverage banner + CSV-attachment button + CTA)
 *   - SES sender
 *
 * Runtime: Node.js 20.x. Deps: @aws-sdk/client-ses, @aws-sdk/client-secrets-manager
 */
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { createHmac, timingSafeEqual } from 'node:crypto'

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1'
// US data centre; use https://api.eu.newrelic.com/graphql for EU accounts.
const NERDGRAPH_URL = process.env.NERDGRAPH_URL ?? 'https://api.newrelic.com/graphql'

const sesClient = new SESClient({ region: AWS_REGION })
const secretsClient = new SecretsManagerClient({ region: AWS_REGION })

// ---- Secrets (cached for the life of a warm Lambda container) ---------------
let cachedSecrets: Record<string, string> | null = null

/** Read and cache the JSON secret bundle (NR API key, HMAC secret, SES config). */
export async function getSecrets(): Promise<Record<string, string>> {
  if (cachedSecrets) return cachedSecrets
  const secretResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN! }))
  const parsedSecrets: Record<string, string> = JSON.parse(secretResponse.SecretString ?? '{}')
  cachedSecrets = parsedSecrets
  return parsedSecrets
}

// ---- HMAC webhook verification ----------------------------------------------
/** Constant-time check that the webhook body was signed with our shared secret. */
export function verifySignature(rawBody: string, providedSignature: string, secret: string): boolean {
  const expectedSignature = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const expectedBytes = Buffer.from(expectedSignature)
  const providedBytes = Buffer.from(providedSignature || '')
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
}

// ---- NerdGraph (NRQL) client ------------------------------------------------
/** One row of an NRQL result set (column name → value, plus `facet`). */
export interface NrqlResult {
  [column: string]: number | string | null
}

// Resilience knobs (the architecture's "timeouts + exponential backoff"). At
// scale a digest fires ~9 queries and several Lambdas run concurrently, so a
// transient NerdGraph 429/5xx is expected — retry it rather than silently
// dropping a report section to [].
// Parse a numeric env knob, falling back for unset/empty/non-numeric/below-min
// values — so a typo can't zero out the retry loop (which would `throw undefined`).
const intEnv = (name: string, fallback: number, min: number): number => {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}
const NERDGRAPH_TIMEOUT_MS = intEnv('NERDGRAPH_TIMEOUT_MS', 8000, 1)
const NERDGRAPH_MAX_ATTEMPTS = intEnv('NERDGRAPH_MAX_ATTEMPTS', 3, 1) // always >= 1 attempt
const NERDGRAPH_BACKOFF_MS = intEnv('NERDGRAPH_BACKOFF_MS', 300, 0)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Transient = worth retrying: our own timeout (AbortError), a fetch network
 * failure (TypeError), a non-JSON body behind a 2xx (SyntaxError — a proxy/CDN
 * error page), or an HTTP 429/5xx. A bad query (GraphQL `errors`) or a 4xx is
 * permanent — retrying just wastes the Lambda's time, so we don't.
 */
function isTransientNerdGraphError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error instanceof TypeError || error instanceof SyntaxError) return true
  return /HTTP (429|5\d\d)/.test(error.message)
}

/** Run an NRQL query through NerdGraph (retried with backoff) and return its rows. */
export async function runNrql(nrql: string, apiKey: string): Promise<NrqlResult[]> {
  const accountId = Number(process.env.NR_ACCOUNT_ID)
  const graphqlQuery = `{
    actor { account(id: ${accountId}) {
      nrql(query: ${JSON.stringify(nrql)}) { results }
    } }
  }`

  let lastError: unknown
  for (let attempt = 1; attempt <= NERDGRAPH_MAX_ATTEMPTS; attempt++) {
    // Abort slow NerdGraph calls so the Lambda can still send a (degraded) email.
    const abortController = new AbortController()
    const abortTimeoutHandle = setTimeout(() => abortController.abort(), NERDGRAPH_TIMEOUT_MS)
    try {
      const httpResponse = await fetch(NERDGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
        body: JSON.stringify({ query: graphqlQuery }),
        signal: abortController.signal,
      })
      if (!httpResponse.ok) throw new Error(`NerdGraph HTTP ${httpResponse.status}`)
      const graphqlResponse = await httpResponse.json()
      if (graphqlResponse.errors) throw new Error(`NerdGraph: ${JSON.stringify(graphqlResponse.errors)}`)
      return graphqlResponse.data?.actor?.account?.nrql?.results ?? []
    } catch (error) {
      lastError = error
      if (attempt >= NERDGRAPH_MAX_ATTEMPTS || !isTransientNerdGraphError(error)) throw error
      await sleep(NERDGRAPH_BACKOFF_MS * 2 ** (attempt - 1)) // 300ms, 600ms, …
    } finally {
      clearTimeout(abortTimeoutHandle)
    }
  }
  throw lastError // unreachable (loop returns or throws), but keeps the type checker happy
}

/** Best-effort NRQL: returns [] instead of throwing, so the email still sends. */
export async function safeNrql(nrql: string, apiKey: string): Promise<NrqlResult[]> {
  try {
    return await runNrql(nrql, apiKey)
  } catch (error) {
    console.error('NRQL failed, continuing in degraded mode:', error)
    return []
  }
}

// ---- HTML rendering (Outlook/MSO-safe) --------------------------------------
// Email-safe font stack — Outlook (Word engine) doesn't know `system-ui` and
// ignores the `font:` shorthand (both fall back to Times New Roman), so every
// style below uses a real family + longhand font-* props.
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

// Gradient + glass design tokens (mirror the mock report). Each gradient ships
// with a solid fallback (bgcolor) for clients that ignore background-image
// (Outlook, much of Gmail); backdrop-filter (frosted glass) only renders in
// webkit/blink + Apple Mail.
const FALLBACK = { page: '#eef1f8', hero: '#4f46e5', banner: '#e7f7ef', download: '#33506e', dashboard: '#0bb673' }
const GRAD = {
  page: 'linear-gradient(160deg,#e9ecfb 0%,#eef1f8 45%,#f5effb 100%)',
  hero: 'linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%)',
  banner: 'linear-gradient(135deg,#e7f7ef 0%,#d8f0e4 100%)',
}

/**
 * Bulletproof rounded button: a VML <v:roundrect> for Outlook (Word engine, which
 * ignores border-radius) and an HTML element for every other client.
 * Pass { href } for a link; omit it for a static cue (e.g. the "attached" CSV chip).
 */
function emailButton(label: string, solidColor: string, opts: { href?: string; download?: string; gradFrom?: string; gradTo?: string } = {}): string {
  const widthPx = Math.round(label.length * 8 + 52) // VML needs an explicit width
  const vmlHref = opts.href ? ` href="${opts.href}"` : ''
  const downloadAttr = opts.download ? ` download="${opts.download}"` : ''
  // Modern clients layer the gradient over the solid; Outlook fills via <v:fill>.
  const gradientCss = opts.gradFrom && opts.gradTo ? `;background-image:linear-gradient(135deg,${opts.gradFrom} 0%,${opts.gradTo} 100%)` : ''
  const vmlGradient = opts.gradFrom && opts.gradTo ? `<v:fill type="gradient" angle="135" color="${opts.gradFrom}" color2="${opts.gradTo}"/>` : ''
  const buttonStyle = `display:inline-block;padding:11px 20px;font-family:${FONT};font-size:13px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;background-color:${solidColor}${gradientCss};border-radius:10px;box-shadow:0 6px 16px rgba(49,46,129,0.18);margin:0 8px 8px 0`
  const htmlEl = opts.href
    ? `<a href="${opts.href}"${downloadAttr} style="${buttonStyle}">${label}</a>`
    : `<span style="${buttonStyle}">${label}</span>`
  return `<!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"${vmlHref} style="height:42px;v-text-anchor:middle;width:${widthPx}px;mso-padding-alt:0" arcsize="22%" stroke="f" fillcolor="${solidColor}">
      ${vmlGradient}<w:anchorlock/><center style="color:#ffffff;font-family:${FONT};font-size:13px;font-weight:700">${label}</center>
    </v:roundrect>
    <![endif]--><!--[if !mso]><!-->${htmlEl}<!--<![endif]-->`
}

/** A simple key/value section (used by the single-page + incident emails). */
export interface ReportSection {
  heading: string
  rows: Array<{ label: string; value: string; bad?: boolean }>
}

/** Render a list of key/value sections inside the branded email shell. */
export function renderHtml(title: string, intro: string, sections: ReportSection[], newRelicLink: string): string {
  const sectionsHtml = sections
    .map((section) => {
      const rowsHtml = section.rows
        .map((row) => {
          const valueColor = row.bad ? '#c0392b' : '#1a7a3c'
          return `<tr>
              <td style="padding:6px 10px;border:1px solid #eee;font-family:${FONT};font-size:13px;color:#555">${row.label}</td>
              <td style="padding:6px 10px;border:1px solid #eee;font-family:${FONT};font-size:13px;font-weight:600;color:${valueColor}">${row.value}</td>
            </tr>`
        })
        .join('')
      return `
      <h3 style="margin:18px 0 8px;font-family:${FONT};font-size:14px;font-weight:700;color:#312e81">${section.heading}</h3>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
        ${rowsHtml}
      </table>`
    })
    .join('')
  return emailShell(title, intro, sectionsHtml, newRelicLink, 'Open in New Relic →')
}

/** A single table cell: its text and whether to flag it red. */
export interface Cell {
  v: string
  bad?: boolean
}

/** Render a titled multi-column table (used by the fleet digests). */
export function tableHtml(title: string, headers: string[], rows: Cell[][]): string {
  const headerCells = headers
    .map((header) => `<th align="left" style="padding:7px 10px;border-bottom:2px solid #e6e8f4;font-family:${FONT};font-size:12px;font-weight:600;color:#6b7280">${header}</th>`)
    .join('')
  const hasRows = rows.length > 0
  const bodyRows = hasRows
    ? rows
        .map((cells, rowIndex) => {
          const zebra = rowIndex % 2 === 1 // subtle alternating tint
          const rowAttr = zebra ? ' bgcolor="#f6f7fc"' : ''
          const rowCss = zebra ? 'background-color:#f6f7fc;' : ''
          const cellsHtml = cells
            .map((cell) => {
              const cellColor = cell.bad ? '#c0392b' : '#222'
              const cellWeight = cell.bad ? 600 : 400
              return `<td style="${rowCss}padding:7px 10px;border-bottom:1px solid #eef0f6;font-family:${FONT};font-size:13px;color:${cellColor};font-weight:${cellWeight}">${cell.v}</td>`
            })
            .join('')
          return `<tr${rowAttr}>${cellsHtml}</tr>`
        })
        .join('')
    : `<tr><td colspan="${headers.length}" style="padding:8px 10px;font-family:${FONT};font-size:13px;color:#888">No data</td></tr>`
  return `
    <h3 style="margin:20px 0 8px;font-family:${FONT};font-size:14px;font-weight:700;color:#312e81">${title}</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt"><thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody></table>`
}

/** Optional extras for the consolidated fleet-email shell (all backward-compatible). */
export interface EmailShellOptions {
  /** Green "Coverage:" banner under the intro (e.g. "6,000 pages crawled · 5,842 RUM"). */
  coverage?: string
  /** Per-page CSV attached to the email — shown as a "⬇ <name> (attached)" button. */
  csvAttachmentName?: string
}

/** Wrap arbitrary inner HTML in the branded email shell + CTA button. */
export function wrapEmail(
  title: string,
  intro: string,
  innerHtml: string,
  ctaUrl: string,
  ctaLabel = 'Open in New Relic →',
  options: EmailShellOptions = {},
): string {
  return emailShell(title, intro, innerHtml, ctaUrl, ctaLabel, options)
}

/** The common card/shell every email shares (consolidated layout). */
function emailShell(title: string, intro: string, innerHtml: string, ctaUrl: string, ctaLabel: string, options: EmailShellOptions = {}): string {
  const coverageBanner = options.coverage
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FALLBACK.banner}" style="background-color:${FALLBACK.banner};background-image:${GRAD.banner};border:1px solid #bfe9d2;border-radius:10px;margin:0 0 16px">
        <tr><td style="padding:11px 14px;font-family:${FONT};font-size:13px;line-height:1.4;color:#246b43"><strong style="color:#1a7a3c">Coverage:</strong> ${options.coverage}</td></tr>
      </table>`
    : ''
  // The CSV is a real SES attachment; this button is the in-body cue for it (no link).
  const csvButton = options.csvAttachmentName ? emailButton(`⬇ ${options.csvAttachmentName} (attached)`, FALLBACK.download, { gradFrom: '#3a5a7a', gradTo: '#22384f' }) : ''
  const ctaButton = emailButton(ctaLabel, FALLBACK.dashboard, { href: ctaUrl, gradFrom: '#10c47e', gradTo: '#089d63' })
  const glassCard = `background-color:rgba(255,255,255,0.72);-webkit-backdrop-filter:saturate(140%) blur(16px);backdrop-filter:saturate(140%) blur(16px);border:1px solid rgba(255,255,255,0.65)`
  // Gradient page bg (+ VML v:background for Outlook) + frosted-glass card +
  // gradient hero band + gradient buttons/banner. Each gradient has a solid
  // bgcolor fallback (Outlook/Gmail); backdrop-filter only renders in webkit/blink.
  return `<!doctype html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  body,table,td{ -webkit-text-size-adjust:100%; -ms-text-size-adjust:100% }
  table,td{ mso-table-lspace:0pt; mso-table-rspace:0pt }
  table{ border-collapse:collapse }
  img{ border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic }
  body{ margin:0; padding:0; width:100% }
</style>
</head>
<body style="margin:0;padding:0;background-color:${FALLBACK.page}">
  <!--[if mso]><v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t"><v:fill type="gradient" angle="160" color="#e9ecfb" color2="#f5effb"/></v:background><![endif]-->
  <center style="width:100%;background-color:${FALLBACK.page};background-image:${GRAD.page}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FALLBACK.page}" style="background-color:${FALLBACK.page};background-image:${GRAD.page}">
    <tr><td align="center" style="padding:28px 12px">
      <!--[if mso]><table role="presentation" width="760" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:760px;margin:0 auto;${glassCard};border-radius:18px;box-shadow:0 18px 50px rgba(49,46,129,0.18);overflow:hidden">
        <tr><td style="padding:0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FALLBACK.hero}" style="background-color:${FALLBACK.hero};background-image:${GRAD.hero};border-radius:18px 18px 0 0">
            <tr><td style="padding:24px 26px">
              <h2 style="margin:0 0 5px;font-family:${FONT};font-size:19px;font-weight:700;line-height:1.3;color:#ffffff">${title}</h2>
              <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.4;color:#e7e3ff">${intro}</p>
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 26px 26px">
            ${coverageBanner}
            ${csvButton}
            ${innerHtml}
            <p style="margin:22px 0 0">${ctaButton}${csvButton}</p>
          </td></tr></table>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
  </center>
</body>
</html>`
}

// ---- SES sender -------------------------------------------------------------
/** Send a plain HTML email (no attachments) via SES. */
export async function sendEmail(message: { from: string; to: string[]; subject: string; html: string }): Promise<void> {
  await sesClient.send(
    new SendEmailCommand({
      Source: message.from,
      Destination: { ToAddresses: message.to },
      Message: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: message.html, Charset: 'UTF-8' } },
      },
    }),
  )
}

// ---- small formatting helpers -----------------------------------------------
/** Read a numeric column as a fixed-decimal string ("n/a" if missing). */
export const num = (row: NrqlResult | undefined, column: string, decimals = 0): string =>
  row && row[column] != null ? Number(row[column]).toFixed(decimals) : 'n/a'

/** Read a numeric column as a number (with a fallback). */
export const val = (row: NrqlResult | undefined, column: string, fallback = 0): number =>
  row && row[column] != null ? Number(row[column]) : fallback
