/**
 * scripts/report.mjs — the ACTUAL daily report generator for the mock.
 *
 * Reads every collected event from the store (our NRDB stand-in), aggregates it
 * the way the real Lambda would with NRQL, renders an HTML email (with inline
 * SVG charts) plus a per-page CSV, and writes both to ./out.
 *
 * Two data sources are merged, exactly as in the architecture:
 *   - Crawl* events  (from scripts/crawl.mjs) → coverage of ALL pages.
 *   - RUM events     (ComponentRender / ApiCall / CtaRedirect, sent by the page
 *                     instrumentation while you browse) → real client timings.
 *
 * Run:  npm run report
 */
import { readEvents } from '@mock/telemetry'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.join(process.cwd(), 'out')

// --- small stats helpers -----------------------------------------------------
const round = (value, decimals = 0) => Number((value || 0).toFixed(decimals))
const average = (numbers) => (numbers.length ? numbers.reduce((sum, n) => sum + n, 0) / numbers.length : 0)

/** The p-th percentile of a list of numbers (e.g. percentile(xs, 75)). */
function percentile(numbers, p) {
  if (numbers.length === 0) return 0
  const sorted = [...numbers].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

/** Group an array into a Map keyed by the result of keyOf(). */
function groupBy(items, keyOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}

/**
 * Keep only the most recent event per key. The store is append-only, so each
 * crawl re-adds the same (slug, component, …) keys; deduping to the latest makes
 * the report idempotent — re-running the crawl reflects the newest pass, not a sum.
 */
function latestByKey(events, keyOf) {
  const latest = new Map()
  for (const event of events) {
    const key = keyOf(event)
    const existing = latest.get(key)
    if (!existing || (event.ts ?? 0) >= (existing.ts ?? 0)) latest.set(key, event)
  }
  return [...latest.values()]
}

// --- inline SVG horizontal bar chart (email-safe: no JS, no remote images) ---
function horizontalBarChart(title, bars, { unit = '', threshold } = {}) {
  if (bars.length === 0) return `<p style="color:#888;font:13px system-ui">${title}: no data</p>`

  const WIDTH = 680, ROW_HEIGHT = 26, TOP = 28, LABEL_WIDTH = 200, VALUE_WIDTH = 70
  const barAreaWidth = WIDTH - LABEL_WIDTH - VALUE_WIDTH
  const maxValue = Math.max(1, ...bars.map((b) => b.value))
  const height = TOP + bars.length * ROW_HEIGHT + 8

  const rowsSvg = bars
    .map((bar, i) => {
      const y = TOP + i * ROW_HEIGHT
      const barWidth = (bar.value / maxValue) * barAreaWidth
      const color = bar.bad ? '#c0392b' : '#0bb673'
      return `
        <text x="${LABEL_WIDTH - 8}" y="${y + 15}" text-anchor="end" font-family="system-ui" font-size="11" fill="#444">${bar.label}</text>
        <rect x="${LABEL_WIDTH}" y="${y + 4}" width="${barWidth.toFixed(1)}" height="16" rx="2" fill="${color}"/>
        <text x="${LABEL_WIDTH + barWidth + 6}" y="${y + 16}" font-family="system-ui" font-size="11" fill="${bar.bad ? '#c0392b' : '#222'}" font-weight="${bar.bad ? 700 : 400}">${bar.value}${unit}</text>`
    })
    .join('')

  const thresholdSvg =
    threshold != null
      ? `<line x1="${LABEL_WIDTH + (threshold / maxValue) * barAreaWidth}" y1="${TOP - 4}" x2="${LABEL_WIDTH + (threshold / maxValue) * barAreaWidth}" y2="${height - 8}" stroke="#e0a000" stroke-dasharray="4 3"/>`
      : ''

  return `
    <h3 style="margin:18px 0 4px;font:600 14px system-ui;color:#1a1a1a">${title}</h3>
    <svg width="100%" viewBox="0 0 ${WIDTH} ${height}" style="border:1px solid #eee;border-radius:6px">
      ${thresholdSvg}${rowsSvg}
    </svg>`
}

// --- HTML helpers ------------------------------------------------------------
function table(title, headers, rows) {
  const head = headers.map((h) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font:600 12px system-ui;color:#444">${h}</th>`).join('')
  const body = rows.length
    ? rows.map((cells) => `<tr>${cells.map((c) => `<td style="padding:6px 10px;border-bottom:1px solid #eee;font:13px system-ui;color:${c.bad ? '#c0392b' : '#222'};font-weight:${c.bad ? 600 : 400}">${c.text}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" style="padding:8px 10px;color:#888;font:13px system-ui">No data</td></tr>`
  return `<h3 style="margin:18px 0 4px;font:600 14px system-ui;color:#1a1a1a">${title}</h3>
    <table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

const cell = (text, bad = false) => ({ text, bad })

// thresholds used to flag a metric red (tune to your SLOs)
const LIMITS = { renderSuccessPct: 99, renderMs: 800, apiMs: 1500, loadMs: 3000, redirectMs: 2500 }

async function main() {
  const events = await readEvents()
  if (events.length === 0) {
    console.error('No telemetry yet. Run `npm run crawl` and/or browse some pages first.')
    process.exit(1)
  }

  // Split the stream by event type.
  const byType = (type) => events.filter((e) => e.eventType === type)

  // Crawl events: dedupe to the latest pass per natural key (idempotent report).
  const crawlPages = latestByKey(byType('CrawlPageMetric'), (e) => e.fundSlug)
  const crawlComponents = latestByKey(byType('CrawlComponentMetric'), (e) => `${e.fundSlug}|${e.component}`)
  const crawlApi = latestByKey(byType('CrawlApiMetric'), (e) => `${e.fundSlug}|${e.endpoint}`)

  // RUM events: keep every sample (percentiles need the full distribution).
  const rumRenders = byType('ComponentRender') // from real browsing
  const apiEvents = [...byType('ApiCall'), ...crawlApi]
  const ctaRedirects = byType('CtaRedirect')

  // ---- Fleet summary -------------------------------------------------------
  const pagesCrawled = new Set(crawlPages.map((e) => e.fundSlug)).size
  const loadTimes = crawlPages.map((e) => e.loadMs).filter((n) => typeof n === 'number')
  const summaryRows = [
    [cell('Pages crawled'), cell(String(pagesCrawled))],
    [cell('Avg page load (ms)'), cell(String(round(average(loadTimes))))],
    [cell('Load p75 (ms)'), cell(String(percentile(loadTimes, 75)), percentile(loadTimes, 75) > LIMITS.loadMs)],
    [cell('Total telemetry events'), cell(String(events.length))],
    [cell('RUM render samples'), cell(String(rumRenders.length))],
  ]

  // ---- Component coverage (crawl) + render latency (RUM) --------------------
  const componentNames = [...new Set(crawlComponents.map((e) => e.component))].sort()
  const componentRows = componentNames.map((name) => {
    const coverage = crawlComponents.filter((e) => e.component === name)
    const renderedPct = coverage.length ? (coverage.filter((e) => e.status === 'rendered').length / coverage.length) * 100 : 0
    const missing = coverage.filter((e) => e.status === 'missing').length

    const rumForComponent = rumRenders.filter((e) => e.component === name && typeof e.renderMs === 'number')
    const renderP75 = percentile(rumForComponent.map((e) => e.renderMs), 75)
    const errors = rumRenders.filter((e) => e.component === name && e.status === 'error').length

    return [
      cell(name),
      cell(round(renderedPct, 1) + '%', renderedPct < LIMITS.renderSuccessPct),
      cell(rumForComponent.length ? renderP75 + ' ms' : '—', renderP75 > LIMITS.renderMs),
      cell(String(errors), errors > 0),
      cell(String(missing), missing > 0),
    ]
  })
  const renderLatencyBars = componentNames
    .map((name) => {
      const samples = rumRenders.filter((e) => e.component === name && typeof e.renderMs === 'number').map((e) => e.renderMs)
      return { label: name, value: percentile(samples, 75), bad: percentile(samples, 75) > LIMITS.renderMs }
    })
    .filter((b) => b.value > 0)

  // ---- Top slowest pages (crawl) -------------------------------------------
  const loadBySlug = groupBy(crawlPages, (e) => e.fundSlug)
  const slowestBars = [...loadBySlug.entries()]
    .map(([slug, pageEvents]) => ({ label: slug.slice(0, 30), value: round(average(pageEvents.map((e) => e.loadMs))), bad: average(pageEvents.map((e) => e.loadMs)) > LIMITS.loadMs }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)

  // ---- API performance (crawl + RUM) ---------------------------------------
  const apiByEndpoint = groupBy(apiEvents, (e) => e.endpoint)
  const apiBars = [...apiByEndpoint.entries()].map(([endpoint, calls]) => {
    const p95 = percentile(calls.map((e) => e.durationMs), 95)
    return { label: endpoint, value: p95, bad: p95 > LIMITS.apiMs }
  })

  // ---- CTA redirect timing (RUM) -------------------------------------------
  const ctaByName = groupBy(ctaRedirects, (e) => e.cta)
  const ctaBars = [...ctaByName.entries()].map(([cta, redirects]) => {
    const p75 = percentile(redirects.map((e) => e.redirectMs), 75)
    return { label: cta, value: p75, bad: p75 > LIMITS.redirectMs }
  })

  // ---- assemble the HTML email --------------------------------------------
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;padding:24px;font-family:system-ui">
    <div style="max-width:760px;margin:auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
      <h2 style="margin:0 0 4px;font:700 18px system-ui">📊 Daily fund-page fleet report (mock)</h2>
      <p style="margin:0 0 8px;color:#666;font:13px system-ui">Generated from ${events.length} collected telemetry events.</p>
      ${table('Fleet summary', ['Metric', 'Value'], summaryRows)}
      ${horizontalBarChart('Component render p75 (ms) — RUM', renderLatencyBars, { unit: '', threshold: LIMITS.renderMs })}
      ${horizontalBarChart('API p95 (ms)', apiBars, { unit: '', threshold: LIMITS.apiMs })}
      ${horizontalBarChart('Top slowest pages — load (ms)', slowestBars, { unit: '', threshold: LIMITS.loadMs })}
      ${horizontalBarChart('CTA → redirect p75 (ms) — RUM', ctaBars, { unit: '', threshold: LIMITS.redirectMs })}
      ${table('Component health — coverage (crawl) & render latency (RUM)', ['Component', 'Rendered %', 'Render p75', 'Errors', 'Missing'], componentRows)}
      <p style="margin:16px 0 0;font:12px system-ui;color:#888">Per-page matrix for all pages attached as <b>fleet.csv</b>.
      Sections marked "RUM" populate as you browse pages (the instrumentation streams events to the collector).</p>
    </div></body></html>`

  // ---- per-page CSV (one row per crawled slug) -----------------------------
  const csvHeader = 'fundSlug,loadMs,httpStatus,componentsRendered,componentsMissing'
  const csvRows = [...loadBySlug.keys()].map((slug) => {
    const pageEvents = loadBySlug.get(slug)
    const comps = crawlComponents.filter((e) => e.fundSlug === slug)
    const rendered = comps.filter((e) => e.status === 'rendered').length
    const missing = comps.filter((e) => e.status === 'missing').length
    return [slug, round(average(pageEvents.map((e) => e.loadMs))), pageEvents[0]?.httpStatus ?? 0, rendered, missing].join(',')
  })
  const csv = [csvHeader, ...csvRows].join('\n')

  // ---- write outputs -------------------------------------------------------
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true })
  await writeFile(path.join(OUT_DIR, 'daily-report.html'), html, 'utf8')
  await writeFile(path.join(OUT_DIR, 'fleet.csv'), csv, 'utf8')

  console.log('Report written:')
  console.log('  out/daily-report.html')
  console.log('  out/fleet.csv')
  console.log(`Summary: ${pagesCrawled} pages, ${events.length} events, ${rumRenders.length} RUM render samples.`)
}

main().catch((error) => {
  console.error('Report failed:', error)
  process.exit(1)
})
