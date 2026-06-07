/**
 * scripts/report.mjs — the ACTUAL daily report generator for the mock.
 *
 * Reads every collected event from the store (our NRDB stand-in), aggregates it
 * the way the real Lambda would with NRQL, and renders ONE consolidated HTML
 * email — email chrome + Outlook-safe bar graphs + aggregate tables + top-N
 * highlights + a "Download fleet.csv" button. The email is aggregate-only; the
 * DETAILED per-page breakdown (one row per page) ships as fleet.csv. Both are
 * written to ./preview (override with REPORT_OUT_DIR).
 *
 * Two data sources are merged, exactly as in the architecture:
 *   - Crawl* events  (from scripts/crawl.mjs) → coverage of ALL pages.
 *   - RUM events     (ComponentRender / ApiCall / CtaRedirect, sent by the page
 *                     instrumentation while you browse) → real client timings.
 *
 * Run:  npm run report           (just write the files)
 *       npm run generate-report  (write, then open the report in your browser)
 */
import { readEvents } from '@mock/telemetry'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

// Single output folder for the report + CSV. Defaults to ./preview (tracked, so
// the rendered report stays in version control); override with REPORT_OUT_DIR.
const OUT_NAME = process.env.REPORT_OUT_DIR ?? 'preview'
const OUT_DIR = path.join(process.cwd(), OUT_NAME)

// Email-safe font stack: Outlook's Word engine doesn't know `system-ui` and
// ignores the `font:` shorthand — both fall back to Times New Roman — so every
// style below uses a real family + longhand font-* props.
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

// Gradient + glass design tokens. Each gradient ships with a solid fallback
// (bgcolor) for clients that ignore background-image (Outlook, much of Gmail).
// The real frosted glass (backdrop-filter) only renders in webkit/blink + Apple
// Mail; elsewhere the translucent/solid background shows through cleanly.
const FALLBACK = { page: '#eef1f8', hero: '#4f46e5', banner: '#e7f7ef', download: '#33506e', dashboard: '#0bb673' }
const GRAD = {
  page: 'linear-gradient(160deg,#e9ecfb 0%,#eef1f8 45%,#f5effb 100%)',
  hero: 'linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%)',
  banner: 'linear-gradient(135deg,#e7f7ef 0%,#d8f0e4 100%)',
}

// --- small stats helpers -----------------------------------------------------
const round = (value, decimals = 0) => Number((value || 0).toFixed(decimals))
const average = (numbers) => (numbers.length ? numbers.reduce((sum, number) => sum + number, 0) / numbers.length : 0)

/** The percentileRank-th percentile of a list of numbers (e.g. percentile(xs, 75)). */
function percentile(numbers, percentileRank) {
  if (numbers.length === 0) return 0
  const sortedAscending = [...numbers].sort((first, second) => first - second)
  const lastIndex = sortedAscending.length - 1
  const rankIndex = Math.floor((percentileRank / 100) * sortedAscending.length)
  return sortedAscending[Math.min(lastIndex, rankIndex)]
}

/** Group an array into a Map keyed by the result of keyOf(). */
function groupBy(items, keyOf) {
  const itemsByKey = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!itemsByKey.has(key)) itemsByKey.set(key, [])
    itemsByKey.get(key).push(item)
  }
  return itemsByKey
}

/**
 * Keep only the most recent event per key. The store is append-only, so each
 * crawl re-adds the same (slug, component, …) keys; deduping to the latest makes
 * the report idempotent — re-running the crawl reflects the newest pass, not a sum.
 */
function latestByKey(events, keyOf) {
  const latestEventByKey = new Map()
  for (const event of events) {
    const key = keyOf(event)
    const currentLatest = latestEventByKey.get(key)
    const isNewerOrEqual = !currentLatest || (event.ts ?? 0) >= (currentLatest.ts ?? 0)
    if (isNewerOrEqual) latestEventByKey.set(key, event)
  }
  return [...latestEventByKey.values()]
}

// --- Outlook-safe horizontal bar chart ---------------------------------------
// Built from HTML <table> cells with bgcolor + pixel widths (NOT <svg>, which
// Outlook's Word engine can't render, and NOT remote/data: images, which Outlook
// blocks). Renders the same in Outlook desktop, webmail, and the browser preview.
// `bad` bars are red; the SLO threshold is conveyed by that colour (callers still
// pass `threshold` to decide `bad`, so it's accepted and ignored here).
function horizontalBarChart(title, bars, { unit = '' } = {}) {
  const heading = `<h3 style="margin:18px 0 8px;font-family:${FONT};font-size:14px;font-weight:700;color:#312e81">${title}</h3>`
  if (bars.length === 0) return `${heading}<p style="margin:0;color:#888;font-family:${FONT};font-size:13px">No data</p>`

  const BAR_AREA_PX = 360
  const maxValue = Math.max(1, ...bars.map((bar) => bar.value))
  const barRows = bars
    .map((bar) => {
      const barWidthPx = Math.max(2, Math.round((bar.value / maxValue) * BAR_AREA_PX))
      const barColor = bar.bad ? '#c0392b' : '#0bb673'
      const valueColor = bar.bad ? '#c0392b' : '#222'
      const valueWeight = bar.bad ? 700 : 400
      return `
        <tr>
          <td width="170" style="padding:3px 8px 3px 0;font-family:${FONT};font-size:11px;color:#444;text-align:right;white-space:nowrap">${bar.label}</td>
          <td style="padding:3px 0">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td bgcolor="${barColor}" width="${barWidthPx}" height="14" style="background-color:${barColor};width:${barWidthPx}px;height:14px;font-size:0;line-height:0">&nbsp;</td>
              <td style="padding-left:6px;font-family:${FONT};font-size:11px;color:${valueColor};font-weight:${valueWeight};white-space:nowrap">${bar.value}${unit}</td>
            </tr></table>
          </td>
        </tr>`
    })
    .join('')

  return `
    ${heading}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #eee;border-radius:6px">
      <tr><td style="padding:10px 12px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">${barRows}</table>
      </td></tr>
    </table>`
}

// --- HTML helpers (Outlook-safe: longhand fonts, role="presentation" tables) --
function table(title, headers, rows) {
  const headerCellsHtml = headers
    .map((header) => `<th align="left" style="padding:7px 10px;border-bottom:2px solid #e6e8f4;font-family:${FONT};font-size:12px;font-weight:600;color:#6b7280">${header}</th>`)
    .join('')
  const bodyRowsHtml = rows.length
    ? rows
        .map((rowCells, rowIndex) => {
          const zebra = rowIndex % 2 === 1 // subtle alternating tint
          const rowAttr = zebra ? ' bgcolor="#f6f7fc"' : ''
          const rowCss = zebra ? 'background-color:#f6f7fc;' : ''
          return `<tr${rowAttr}>${rowCells.map((cell) => `<td style="${rowCss}padding:7px 10px;border-bottom:1px solid #eef0f6;font-family:${FONT};font-size:13px;color:${cell.bad ? '#c0392b' : '#222'};font-weight:${cell.bad ? 600 : 400}">${cell.text}</td>`).join('')}</tr>`
        })
        .join('')
    : `<tr><td colspan="${headers.length}" style="padding:8px 10px;font-family:${FONT};font-size:13px;color:#888">No data</td></tr>`
  return `<h3 style="margin:20px 0 8px;font-family:${FONT};font-size:14px;font-weight:700;color:#312e81">${title}</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt"><thead><tr>${headerCellsHtml}</tr></thead><tbody>${bodyRowsHtml}</tbody></table>`
}

/**
 * Bulletproof rounded button: a VML <v:roundrect> for Outlook (Word engine, which
 * ignores border-radius) and an HTML element for every other client.
 * Pass { href } for a link; omit it for a static cue (e.g. the "attached" chip).
 * { msoLink:false } keeps the HTML link but drops it from the VML — for data: URIs
 * that Outlook blocks anyway.
 */
function emailButton(label, solidColor, { href, download, msoLink = true, gradFrom, gradTo } = {}) {
  const widthPx = Math.round(label.length * 8 + 52) // VML needs an explicit width
  const vmlHref = href && msoLink ? ` href="${href}"` : ''
  const downloadAttr = download ? ` download="${download}"` : ''
  // Modern clients layer the gradient over the solid; Outlook fills via <v:fill>.
  const gradientCss = gradFrom && gradTo ? `;background-image:linear-gradient(135deg,${gradFrom} 0%,${gradTo} 100%)` : ''
  const vmlGradient = gradFrom && gradTo ? `<v:fill type="gradient" angle="135" color="${gradFrom}" color2="${gradTo}"/>` : ''
  const buttonStyle = `display:inline-block;padding:11px 20px;font-family:${FONT};font-size:13px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;background-color:${solidColor}${gradientCss};border-radius:10px;box-shadow:0 6px 16px rgba(49,46,129,0.18);margin:0 8px 8px 0`
  const htmlEl = href
    ? `<a href="${href}"${downloadAttr} style="${buttonStyle}">${label}</a>`
    : `<span style="${buttonStyle}">${label}</span>`
  return `<!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"${vmlHref} style="height:42px;v-text-anchor:middle;width:${widthPx}px;mso-padding-alt:0" arcsize="22%" stroke="f" fillcolor="${solidColor}">
      ${vmlGradient}<w:anchorlock/><center style="color:#ffffff;font-family:${FONT};font-size:13px;font-weight:700">${label}</center>
    </v:roundrect>
    <![endif]--><!--[if !mso]><!-->${htmlEl}<!--<![endif]-->`
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
  const byType = (type) => events.filter((event) => event.eventType === type)

  // Crawl events: dedupe to the latest pass per natural key (idempotent report).
  const crawlPages = latestByKey(byType('CrawlPageMetric'), (event) => event.fundSlug)
  const crawlComponents = latestByKey(byType('CrawlComponentMetric'), (event) => `${event.fundSlug}|${event.component}`)
  const crawlApi = latestByKey(byType('CrawlApiMetric'), (event) => `${event.fundSlug}|${event.endpoint}`)

  // RUM events: keep every sample (percentiles need the full distribution).
  const rumRenders = byType('ComponentRender') // from real browsing
  const apiEvents = [...byType('ApiCall'), ...crawlApi]
  const ctaRedirects = byType('CtaRedirect')

  // ---- Fleet summary -------------------------------------------------------
  const pagesCrawled = new Set(crawlPages.map((page) => page.fundSlug)).size
  const loadTimes = crawlPages.map((page) => page.loadMs).filter((loadMs) => typeof loadMs === 'number')
  const loadP75 = percentile(loadTimes, 75)
  const summaryRows = [
    [cell('Pages crawled'), cell(String(pagesCrawled))],
    [cell('Avg page load (ms)'), cell(String(round(average(loadTimes))))],
    [cell('Load p75 (ms)'), cell(String(loadP75), loadP75 > LIMITS.loadMs)],
    [cell('Total telemetry events'), cell(String(events.length))],
    [cell('RUM render samples'), cell(String(rumRenders.length))],
  ]

  // ---- Component coverage (crawl) + render latency (RUM) --------------------
  const componentNames = [...new Set(crawlComponents.map((component) => component.component))].sort()
  const componentRows = componentNames.map((componentName) => {
    const coverageSamples = crawlComponents.filter((component) => component.component === componentName)
    const renderedCount = coverageSamples.filter((component) => component.status === 'rendered').length
    const renderedPct = coverageSamples.length ? (renderedCount / coverageSamples.length) * 100 : 0
    const missingCount = coverageSamples.filter((component) => component.status === 'missing').length

    const rumForComponent = rumRenders.filter((render) => render.component === componentName && typeof render.renderMs === 'number')
    const renderP75 = percentile(rumForComponent.map((render) => render.renderMs), 75)
    const errorCount = rumRenders.filter((render) => render.component === componentName && render.status === 'error').length

    return [
      cell(componentName),
      cell(round(renderedPct, 1) + '%', renderedPct < LIMITS.renderSuccessPct),
      cell(rumForComponent.length ? renderP75 + ' ms' : '—', renderP75 > LIMITS.renderMs),
      cell(String(errorCount), errorCount > 0),
      cell(String(missingCount), missingCount > 0),
    ]
  })
  const renderLatencyBars = componentNames
    .map((componentName) => {
      const renderSamples = rumRenders.filter((render) => render.component === componentName && typeof render.renderMs === 'number').map((render) => render.renderMs)
      const renderP75 = percentile(renderSamples, 75)
      return { label: componentName, value: renderP75, bad: renderP75 > LIMITS.renderMs }
    })
    .filter((bar) => bar.value > 0)

  // ---- Top slowest pages (crawl) -------------------------------------------
  const pagesBySlug = groupBy(crawlPages, (page) => page.fundSlug)
  const slowestBars = [...pagesBySlug.entries()]
    .map(([slug, pagesForSlug]) => {
      const averageLoadMs = average(pagesForSlug.map((page) => page.loadMs))
      return { label: slug.slice(0, 30), value: round(averageLoadMs), bad: averageLoadMs > LIMITS.loadMs }
    })
    .sort((firstBar, secondBar) => secondBar.value - firstBar.value)
    .slice(0, 10)

  // ---- API performance (crawl + RUM) ---------------------------------------
  const apiByEndpoint = groupBy(apiEvents, (apiCall) => apiCall.endpoint)
  const apiBars = [...apiByEndpoint.entries()].map(([endpoint, apiCalls]) => {
    const durationP95 = percentile(apiCalls.map((apiCall) => apiCall.durationMs), 95)
    return { label: endpoint, value: durationP95, bad: durationP95 > LIMITS.apiMs }
  })

  // ---- CTA redirect timing (RUM) -------------------------------------------
  const redirectsByCta = groupBy(ctaRedirects, (redirect) => redirect.cta)
  const ctaBars = [...redirectsByCta.entries()].map(([cta, redirectsForCta]) => {
    const redirectP75 = percentile(redirectsForCta.map((redirect) => redirect.redirectMs), 75)
    return { label: cta, value: redirectP75, bad: redirectP75 > LIMITS.redirectMs }
  })

  // ---- per-page DETAIL → CSV only (one row per crawled slug) ---------------
  // The HTML email is aggregate-only (fleet summary + charts + top-N); the full
  // per-page breakdown — the "detailed data for each page" — ships as fleet.csv.
  // Pre-group once so building the rows stays O(n), not O(slugs × events).
  const componentsBySlug = groupBy(crawlComponents, (component) => component.fundSlug)
  const apiBySlug = groupBy(crawlApi, (apiCall) => apiCall.fundSlug)
  const csvHeader = 'fundSlug,loadMs,httpStatus,jsErrors,componentsRendered,componentsMissing,missingComponents,apiMs,apiHttpStatus'
  const perPage = [...pagesBySlug.keys()].map((slug) => {
    const pagesForSlug = pagesBySlug.get(slug)
    const componentsForSlug = componentsBySlug.get(slug) ?? []
    const apiForSlug = apiBySlug.get(slug) ?? []
    const missingComponentNames = componentsForSlug.filter((component) => component.status === 'missing').map((component) => component.component)
    return {
      slug,
      loadMs: round(average(pagesForSlug.map((page) => page.loadMs))),
      httpStatus: pagesForSlug[0]?.httpStatus ?? 0,
      jsErrors: pagesForSlug.reduce((total, page) => total + (page.jsErrors ?? 0), 0),
      renderedCount: componentsForSlug.filter((component) => component.status === 'rendered').length,
      missingCount: missingComponentNames.length,
      missingComponents: missingComponentNames.join('|'), // pipe-separated; keeps the CSV comma-safe
      apiMs: apiForSlug.length ? round(average(apiForSlug.map((apiCall) => apiCall.durationMs))) : '',
      apiHttpStatus: apiForSlug[0]?.httpStatus ?? '',
    }
  })
  const csv = [
    csvHeader,
    ...perPage.map((row) =>
      [row.slug, row.loadMs, row.httpStatus, row.jsErrors, row.renderedCount, row.missingCount, row.missingComponents, row.apiMs, row.apiHttpStatus].join(','),
    ),
  ].join('\n')
  const csvDownloadUri = `data:text/csv;base64,${Buffer.from(csv, 'utf8').toString('base64')}`

  // ---- extra tables that the consolidated email merges in -------------------
  const pagesWithRumData = new Set(rumRenders.map((render) => render.fundSlug).filter(Boolean)).size
  const renderErrorCount = rumRenders.filter((render) => render.status === 'error').length

  const slowestPageRows = [...pagesBySlug.entries()]
    .map(([slug, pagesForSlug]) => ({ slug, loadMs: round(average(pagesForSlug.map((page) => page.loadMs))) }))
    .sort((first, second) => second.loadMs - first.loadMs)
    .slice(0, 10)
    .map(({ slug, loadMs }) => [cell(slug), cell(`${loadMs} ms`, loadMs > LIMITS.loadMs)])

  const failureCountByPageComponent = new Map()
  const addFailure = (fundSlug, component) => {
    const key = `${fundSlug}|${component}`
    failureCountByPageComponent.set(key, (failureCountByPageComponent.get(key) ?? 0) + 1)
  }
  for (const render of rumRenders) if (render.status === 'error') addFailure(render.fundSlug, render.component)
  for (const component of crawlComponents) if (component.status === 'missing') addFailure(component.fundSlug, component.component)
  const renderFailureRows = [...failureCountByPageComponent.entries()]
    .map(([key, failures]) => { const [slug, component] = key.split('|'); return { slug, component, failures } })
    .sort((first, second) => second.failures - first.failures)
    .slice(0, 10)
    .map(({ slug, component, failures }) => [cell(slug), cell(component), cell(String(failures), true)])

  const apiPerformanceRows = [...apiByEndpoint.entries()].map(([endpoint, apiCalls]) => {
    const durationP95 = percentile(apiCalls.map((apiCall) => apiCall.durationMs), 95)
    const failedCalls = apiCalls.filter((apiCall) => (apiCall.httpStatus ?? 200) >= 400).length
    const errorPct = apiCalls.length ? round((failedCalls / apiCalls.length) * 100, 1) : 0
    return [cell(endpoint), cell(`${durationP95} ms`, durationP95 > LIMITS.apiMs), cell(`${errorPct}%`, errorPct > 0), cell(String(apiCalls.length))]
  })

  const ctaTimingRows = [...redirectsByCta.entries()].map(([cta, redirectsForCta]) => {
    const redirectP75 = percentile(redirectsForCta.map((redirect) => redirect.redirectMs), 75)
    const redirectP95 = percentile(redirectsForCta.map((redirect) => redirect.redirectMs), 95)
    return [cell(cta), cell(`${redirectP75} ms`, redirectP75 > LIMITS.redirectMs), cell(`${redirectP95} ms`), cell(String(redirectsForCta.length))]
  })

  // ---- assemble ONE consolidated email -------------------------------------
  // Email chrome (From/To/Subject + CSV attachment) + coverage banner + graphs +
  // aggregate tables + top-N highlights + a self-contained "Download fleet.csv"
  // button. The per-page detail is NOT in the email — it's in the attached CSV.
  // This is the single mail the reporting Lambda sends; `npm run generate-report`
  // previews it in the browser.
  const subject = `Fleet digest: mf-detail — ${pagesCrawled} pages crawled, ${renderErrorCount} render errors`
  const intro = `Template-wide health from ${events.length} collected telemetry events.`
  const coverageText = `${pagesCrawled} pages crawled (active) · ${pagesWithRumData} with real-user data (RUM) · ${rumRenders.length} render samples`
  // data: URI works in the browser preview; Outlook blocks it, but the real Lambda
  // email ships fleet.csv as an SES attachment (the 📎 chip reflects that).
  const downloadCsvButton = emailButton('⬇ Download fleet.csv', FALLBACK.download, { href: csvDownloadUri, download: 'fleet.csv', msoLink: false, gradFrom: '#3a5a7a', gradTo: '#22384f' })
  const dashboardButton = emailButton('Open fleet dashboard →', FALLBACK.dashboard, { href: 'https://one.newrelic.com', gradFrom: '#10c47e', gradTo: '#089d63' })

  const sections =
    table('Fleet summary', ['Metric', 'Value'], summaryRows) +
    horizontalBarChart('Component render p75 (ms) — RUM', renderLatencyBars) +
    horizontalBarChart('API p95 (ms)', apiBars) +
    horizontalBarChart('Top slowest pages — load (ms)', slowestBars) +
    horizontalBarChart('CTA → redirect p75 (ms) — RUM', ctaBars) +
    table('Component health — coverage (crawl) & render latency (RUM)', ['Component', 'Rendered %', 'Render p75', 'Errors', 'Missing'], componentRows) +
    table('Top 10 slowest pages — load', ['Fund slug', 'Load'], slowestPageRows) +
    table('Top render failures (error / missing)', ['Fund slug', 'Component', 'Failures'], renderFailureRows) +
    table('API performance', ['Endpoint', 'p95', 'Error %', 'Calls'], apiPerformanceRows) +
    table('CTA → redirect timing', ['CTA', 'Redirect p75', 'Redirect p95', 'Clicks'], ctaTimingRows)

  // Table-based layout + MSO ghost table for width (Outlook ignores max-width on
  // divs) + <head> DPI/PNG settings + bgcolor attributes. Renders in Outlook
  // desktop, webmail, and the browser preview alike.
  // Gradient page bg (+ VML v:background for Outlook), frosted-glass cards
  // (translucent + backdrop blur where supported; opaque white fallback via
  // bgcolor), a gradient hero band, and gradient buttons/banner.
  const glassCard = `background-color:rgba(255,255,255,0.72);-webkit-backdrop-filter:saturate(140%) blur(16px);backdrop-filter:saturate(140%) blur(16px);border:1px solid rgba(255,255,255,0.65)`
  const html = `<!doctype html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Daily fleet email — fund pages</title>
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

      <!-- email-client chrome (preview-only; not part of the sent body) -->
      <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:760px;margin:0 auto 14px;${glassCard};border-radius:14px;box-shadow:0 10px 30px rgba(49,46,129,0.10)">
        <tr><td style="padding:14px 18px">
          <div style="font-family:${FONT};font-size:12px;color:#8a90a6">From</div>
          <div style="font-family:${FONT};font-size:13px;color:#222">page-monitor@bajajfinserv.in</div>
          <div style="font-family:${FONT};font-size:12px;color:#8a90a6;margin-top:6px">To</div>
          <div style="font-family:${FONT};font-size:13px;color:#222">web-platform@bajajfinserv.in, oncall@bajajfinserv.in</div>
          <div style="font-family:${FONT};font-size:12px;color:#8a90a6;margin-top:6px">Subject</div>
          <div style="font-family:${FONT};font-size:14px;font-weight:600;color:#111">${subject}</div>
          <div style="margin-top:10px"><span style="display:inline-block;background-color:#eef2f7;border:1px solid #d6deea;border-radius:6px;padding:5px 10px;font-family:${FONT};font-size:12px;color:#33506e">📎 fleet.csv — ${perPage.length} rows (detailed, one per page)</span></div>
        </td></tr>
      </table>

      <!-- email body (what the reporting Lambda renders + sends) -->
      <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:760px;margin:0 auto;${glassCard};border-radius:18px;box-shadow:0 18px 50px rgba(49,46,129,0.18);overflow:hidden">
        <tr><td style="padding:0">

          <!-- gradient hero header -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FALLBACK.hero}" style="background-color:${FALLBACK.hero};background-image:${GRAD.hero};border-radius:18px 18px 0 0">
            <tr><td style="padding:24px 26px">
              <h2 style="margin:0 0 5px;font-family:${FONT};font-size:19px;font-weight:700;line-height:1.3;color:#ffffff">📊 Daily fund-page fleet report — mf-detail</h2>
              <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.4;color:#e7e3ff">${intro}</p>
            </td></tr>
          </table>

          <!-- body content -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 26px 26px">

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FALLBACK.banner}" style="background-color:${FALLBACK.banner};background-image:${GRAD.banner};border:1px solid #bfe9d2;border-radius:10px;margin:0 0 16px">
              <tr><td style="padding:11px 14px;font-family:${FONT};font-size:13px;line-height:1.4;color:#246b43"><strong style="color:#1a7a3c">Coverage:</strong> ${coverageText}</td></tr>
            </table>

            ${downloadCsvButton}

            ${sections}

            <p style="margin:18px 0 14px;font-family:${FONT};font-size:12px;line-height:1.4;color:#8a90a6">This email shows fleet aggregates + worst-offender highlights only. The <strong>detailed per-page breakdown (every page)</strong> is in the attached <strong>fleet.csv</strong> (download button above). Sections marked "RUM" come from real browser render samples; crawl sections cover every page.</p>

            ${dashboardButton}${downloadCsvButton}

          </td></tr></table>

        </td></tr>
      </table>

      <!--[if mso]></td></tr></table><![endif]-->

    </td></tr>
  </table>
  </center>
</body>
</html>`

  // ---- write outputs -------------------------------------------------------
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true })
  await writeFile(path.join(OUT_DIR, 'daily-report.html'), html, 'utf8')
  await writeFile(path.join(OUT_DIR, 'fleet.csv'), csv, 'utf8')

  console.log('Report written:')
  console.log(`  ${OUT_NAME}/daily-report.html`)
  console.log(`  ${OUT_NAME}/fleet.csv`)
  console.log(`Summary: ${pagesCrawled} pages, ${events.length} events, ${rumRenders.length} RUM render samples.`)

  // `--open` (or OPEN_REPORT=1) opens the report in the default browser — this is
  // what `npm run generate-report` uses.
  if (process.argv.includes('--open') || process.env.OPEN_REPORT === '1') {
    const reportPath = path.join(OUT_DIR, 'daily-report.html')
    const openCommand = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawn(openCommand, [reportPath], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
    console.log(`Opening ${OUT_NAME}/daily-report.html in your browser…`)
  }
}

main().catch((error) => {
  console.error('Report failed:', error)
  process.exit(1)
})
