/**
 * Shared building blocks used by every report Lambda:
 *   - secrets caching (Secrets Manager)
 *   - NerdGraph (NRQL) client
 *   - HMAC webhook verification
 *   - HTML rendering (key/value sections, multi-column tables, email shell)
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
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN! }))
  cachedSecrets = JSON.parse(response.SecretString ?? '{}')
  return cachedSecrets!
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

/** Run an NRQL query through NerdGraph and return its result rows. */
export async function runNrql(nrql: string, apiKey: string): Promise<NrqlResult[]> {
  const accountId = Number(process.env.NR_ACCOUNT_ID)
  const graphqlQuery = `{
    actor { account(id: ${accountId}) {
      nrql(query: ${JSON.stringify(nrql)}) { results }
    } }
  }`

  // Abort slow NerdGraph calls so the Lambda can still send a (degraded) email.
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 8000)
  try {
    const response = await fetch(NERDGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
      body: JSON.stringify({ query: graphqlQuery }),
      signal: abortController.signal,
    })
    if (!response.ok) throw new Error(`NerdGraph HTTP ${response.status}`)
    const json = await response.json()
    if (json.errors) throw new Error(`NerdGraph: ${JSON.stringify(json.errors)}`)
    return json.data?.actor?.account?.nrql?.results ?? []
  } finally {
    clearTimeout(timeout)
  }
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

// ---- HTML rendering ---------------------------------------------------------
/** A simple key/value section (used by the single-page + incident emails). */
export interface ReportSection {
  heading: string
  rows: Array<{ label: string; value: string; bad?: boolean }>
}

/** Render a list of key/value sections inside the branded email shell. */
export function renderHtml(title: string, intro: string, sections: ReportSection[], newRelicLink: string): string {
  const sectionsHtml = sections
    .map(
      (section) => `
      <h3 style="margin:18px 0 6px;font:600 14px system-ui;color:#1a1a1a">${section.heading}</h3>
      <table style="border-collapse:collapse;width:100%;font:13px system-ui">
        ${section.rows
          .map(
            (row) => `<tr>
              <td style="padding:6px 10px;border:1px solid #eee;color:#555">${row.label}</td>
              <td style="padding:6px 10px;border:1px solid #eee;font-weight:600;color:${row.bad ? '#c0392b' : '#1a7a3c'}">${row.value}</td>
            </tr>`,
          )
          .join('')}
      </table>`,
    )
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
    .map((header) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font:600 12px system-ui;color:#444">${header}</th>`)
    .join('')
  const bodyRows = rows.length
    ? rows
        .map(
          (cells) =>
            `<tr>${cells
              .map(
                (cell) =>
                  `<td style="padding:6px 10px;border-bottom:1px solid #eee;font:13px system-ui;color:${cell.bad ? '#c0392b' : '#222'};font-weight:${cell.bad ? 600 : 400}">${cell.v}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('')
    : `<tr><td colspan="${headers.length}" style="padding:8px 10px;color:#888;font:13px system-ui">No data</td></tr>`
  return `
    <h3 style="margin:20px 0 6px;font:600 14px system-ui;color:#1a1a1a">${title}</h3>
    <table style="border-collapse:collapse;width:100%"><thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody></table>`
}

/** Wrap arbitrary inner HTML in the branded email shell + CTA button. */
export function wrapEmail(title: string, intro: string, innerHtml: string, ctaUrl: string, ctaLabel = 'Open in New Relic →'): string {
  return emailShell(title, intro, innerHtml, ctaUrl, ctaLabel)
}

/** The common card/shell every email shares. */
function emailShell(title: string, intro: string, innerHtml: string, ctaUrl: string, ctaLabel: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;padding:24px">
    <div style="max-width:760px;margin:auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
      <h2 style="margin:0 0 4px;font:700 18px system-ui">${title}</h2>
      <p style="margin:0 0 8px;color:#666;font:13px system-ui">${intro}</p>
      ${innerHtml}
      <p style="margin:22px 0 0">
        <a href="${ctaUrl}" style="display:inline-block;background:#0b6;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font:600 13px system-ui">${ctaLabel}</a>
      </p>
    </div>
  </body></html>`
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
