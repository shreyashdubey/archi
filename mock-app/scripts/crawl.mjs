/**
 * scripts/crawl.mjs — the ACTUAL crawler for the mock.
 *
 * What it does (the "active monitoring" half of the architecture):
 *   1. asks the slug API for the page list (discovered from the live sitemap),
 *   2. samples SAMPLE_SIZE random pages (default 25; 0 = all, like prod),
 *   3. visits each sampled page, timing the load and checking which components rendered,
 *   4. times the calculator API for each page,
 *   5. pushes the results to the collector (/api/telemetry) as Crawl* events.
 *
 * This is a fetch-based crawler: it reads the server-rendered HTML, so it can
 * measure load time, component presence and API timing without a browser. (For
 * client-side render durations and CTA-redirect timing, the report uses the RUM
 * events the page instrumentation sends while you browse — see the report.)
 *
 * Run:  npm run crawl        (needs `npm run dev` running)
 * Env:  BASE_URL     (the mock's URL; auto-detected across ports 3000–3003 if unset)
 *       PORT         (the mock's port, if you pin one; default probes 3000–3003)
 *       SAMPLE_SIZE  (random pages to crawl; default 25, 0 = all ~6,000)
 *       SAMPLE_SEED  (fix the random sample for a reproducible run; default: new each run)
 */
import { resolveBaseUrl, discoverSlugs, sampleSlugs, getSampleConfig } from './lib/discover.mjs'

let BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const CONCURRENCY = 5

// The components we expect on every fund page (must match data-nr-component=…).
const EXPECTED_COMPONENTS = [
  'fund-header', 'returns-summary', 'nav-chart',
  'fund-details-table', 'sip-calculator', 'risk-gauge',
]

const round = (milliseconds) => Math.round(milliseconds)

/** Crawl a single page and return the telemetry events it produced. */
async function crawlPage(slug) {
  const events = []
  const pageUrl = `${BASE_URL}/investments/${slug}?next=true`

  // 1. Load the page, timing the request.
  const pageLoadStartedAt = performance.now()
  let html = ''
  let pageHttpStatus = 0
  try {
    const pageResponse = await fetch(pageUrl)
    pageHttpStatus = pageResponse.status
    html = await pageResponse.text()
  } catch {
    pageHttpStatus = 0
  }
  const loadMs = round(performance.now() - pageLoadStartedAt)

  // 2. Check which components are present in the rendered HTML.
  for (const component of EXPECTED_COMPONENTS) {
    const isRendered = html.includes(`data-nr-component="${component}"`)
    events.push({
      eventType: 'CrawlComponentMetric',
      pageType: 'mf-detail',
      fundSlug: slug,
      component,
      status: isRendered ? 'rendered' : 'missing',
      renderMs: null, // client render time comes from RUM, not server HTML
    })
  }

  // 3. Page-level metric.
  events.push({
    eventType: 'CrawlPageMetric',
    pageType: 'mf-detail',
    fundSlug: slug,
    status: pageHttpStatus >= 200 && pageHttpStatus < 400 ? 'ok' : 'http_error',
    httpStatus: pageHttpStatus,
    loadMs,
    jsErrors: 0,
  })

  // 4. Time the calculator API the page depends on.
  const apiCallStartedAt = performance.now()
  let apiHttpStatus = 0
  try {
    const apiResponse = await fetch(`${BASE_URL}/api/funds/sip-calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthly: 25000, years: 2, rate: 15 }),
    })
    apiHttpStatus = apiResponse.status
  } catch {
    apiHttpStatus = 0
  }
  events.push({
    eventType: 'CrawlApiMetric',
    pageType: 'mf-detail',
    fundSlug: slug,
    endpoint: '/api/funds/sip-calculate',
    durationMs: round(performance.now() - apiCallStartedAt),
    httpStatus: apiHttpStatus,
  })

  return events
}

/** Push a batch of events to the collector. */
async function sendToCollector(events) {
  await fetch(`${BASE_URL}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(events),
  })
}

async function main() {
  BASE_URL = await resolveBaseUrl()
  console.log(`Crawler starting against ${BASE_URL}`)

  // Discover every page from the slug API (sitemap-backed), then sample a subset.
  const { slugs: discovered, total, source } = await discoverSlugs(BASE_URL)
  const { size, seed } = getSampleConfig()
  const slugs = sampleSlugs(discovered, size, { seed })
  const scope = size > 0 && size < total ? `sample of ${slugs.length}` : `all ${slugs.length}`
  console.log(`Discovered ${total} slugs (source: ${source}) — crawling ${scope}`)

  // Crawl with a small concurrency pool (a shared cursor consumed by N workers).
  let nextSlugIndex = 0
  let pagesCrawled = 0
  const allEvents = []

  const worker = async () => {
    while (nextSlugIndex < slugs.length) {
      const slug = slugs[nextSlugIndex++]
      const pageEvents = await crawlPage(slug)
      allEvents.push(...pageEvents)
      pagesCrawled++
      process.stdout.write(`\r  crawled ${pagesCrawled}/${slugs.length}`)
    }
  }
  const workerCount = Math.min(CONCURRENCY, slugs.length)
  await Promise.all(Array.from({ length: workerCount }, worker))

  // Ship everything to the collector.
  await sendToCollector(allEvents)
  console.log(`\nDone — ${pagesCrawled} pages, ${allEvents.length} events sent to the collector.`)
  console.log('Next: npm run report')
}

main().catch((error) => {
  console.error('\nCrawl failed:', error.message)
  console.error(`Could not reach the mock at ${BASE_URL}. Is \`npm run dev\` running?`)
  console.error('(If port 3000 is busy, Next uses another port — set BASE_URL=http://localhost:<port> or PORT=<port>.)')
  process.exit(1)
})
