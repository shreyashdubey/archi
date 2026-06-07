/**
 * Render graphs as PNGs and assemble an email that embeds them inline.
 *
 * Why PNG + inline? Email clients don't run JavaScript and usually block remote
 * images, so charts can't be live <canvas> or hot-linked URLs. We render them
 * server-side to PNG and embed each by Content-ID (cid) in a multipart/related
 * message, sent via SES SendRawEmail.
 *
 * Deps: chartjs-node-canvas, chart.js, @aws-sdk/client-ses
 */
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1'
const sesClient = new SESClient({ region: AWS_REGION })
const chartRenderer = new ChartJSNodeCanvas({ width: 700, height: 300, backgroundColour: 'white' })

const GOOD_COLOR = '#0bb673'
const BAD_COLOR = '#c0392b'

/** One bar in a bar chart: its label, value, and whether it breached a threshold. */
export interface Series {
  label: string
  value: number
  bad?: boolean
}

/** Render a bar chart to a PNG buffer (set `horizontal` for a horizontal bar chart). */
export async function barChartPng(title: string, bars: Series[], horizontal = false): Promise<Buffer> {
  return chartRenderer.renderToBuffer({
    type: 'bar',
    data: {
      labels: bars.map((bar) => bar.label),
      datasets: [
        {
          label: title,
          data: bars.map((bar) => bar.value),
          backgroundColor: bars.map((bar) => (bar.bad ? BAD_COLOR : GOOD_COLOR)),
        },
      ],
    },
    options: {
    
      indexAxis: horizontal ? 'y' : 'x',
      plugins: { title: { display: true, text: title }, legend: { display: false } },
    },
  })
}

/** Render a multi-line time-series to a PNG buffer (e.g. 7-day load & LCP). */
export async function lineChartPng(
  title: string,
  xAxisLabels: string[],
  lines: { label: string; points: number[] }[],
): Promise<Buffer> {
  const linePalette = ['#2d6cdf', '#c0392b', '#0bb673']
  return chartRenderer.renderToBuffer({
    type: 'line',
    data: {
      labels: xAxisLabels,
      datasets: lines.map((line, index) => ({
        label: line.label,
        data: line.points,
        borderColor: linePalette[index % linePalette.length],
        backgroundColor: 'transparent',
        tension: 0.3,
      })),
    },
    options: { plugins: { title: { display: true, text: title } } },
  })
}

// --- MIME builder: HTML body + inline PNGs (by cid) + a CSV attachment --------
/** A PNG to embed inline; reference it in the HTML as `<img src="cid:THE_CID">`. */
export interface InlineImage {
  cid: string
  png: Buffer
}

export function buildMime(message: {
  from: string
  to: string[]
  subject: string
  html: string
  images: InlineImage[]
  csv?: { filename: string; content: string }
}): string {
  const outerBoundary = 'mixed_' + message.subject.replace(/\W+/g, '').slice(0, 16)
  const relatedBoundary = 'rel_' + outerBoundary
  const mimeLines: string[] = []

  // Top-level headers.
  mimeLines.push(`From: ${message.from}`)
  mimeLines.push(`To: ${message.to.join(', ')}`)
  mimeLines.push(`Subject: ${message.subject}`)
  mimeLines.push('MIME-Version: 1.0')
  mimeLines.push(`Content-Type: multipart/mixed; boundary="${outerBoundary}"`, '')

  // Part 1 (related): the HTML body + its inline images.
  mimeLines.push(`--${outerBoundary}`)
  mimeLines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`, '')
  mimeLines.push(`--${relatedBoundary}`)
  mimeLines.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 7bit', '')
  mimeLines.push(message.html, '')
  for (const inlineImage of message.images) {
    const base64Png = inlineImage.png.toString('base64')
    mimeLines.push(`--${relatedBoundary}`)
    mimeLines.push('Content-Type: image/png', 'Content-Transfer-Encoding: base64')
    mimeLines.push(`Content-ID: <${inlineImage.cid}>`, `Content-Disposition: inline; filename="${inlineImage.cid}.png"`, '')
    mimeLines.push(base64Png, '')
  }
  mimeLines.push(`--${relatedBoundary}--`, '')

  // Part 2 (optional): the per-page CSV attachment.
  if (message.csv) {
    const base64Csv = Buffer.from(message.csv.content).toString('base64')
    mimeLines.push(`--${outerBoundary}`)
    mimeLines.push('Content-Type: text/csv; charset=UTF-8', 'Content-Transfer-Encoding: base64')
    mimeLines.push(`Content-Disposition: attachment; filename="${message.csv.filename}"`, '')
    mimeLines.push(base64Csv, '')
  }
  mimeLines.push(`--${outerBoundary}--`, '')

  return mimeLines.join('\r\n')
}

/** Send a pre-built raw MIME message via SES. */
export async function sendRich(rawMime: string): Promise<void> {
  await sesClient.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMime) } }))
}

/** Turn header + rows into CSV text (the all-pages per-page attachment). */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escapeField = (field: string | number) => `"${String(field).replace(/"/g, '""')}"`
  return [headers.map(escapeField).join(','), ...rows.map((row) => row.map(escapeField).join(','))].join('\n')
}
