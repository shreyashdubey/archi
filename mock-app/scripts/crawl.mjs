/**
 * scripts/crawl.mjs — the ACTUAL crawler for the mock.
 *
 * What it does (the "active monitoring" half of the architecture):
 *   1. asks the slug API for the list of pages (stand-in for all 6,000),
 *   2. visits every page, timing the load and checking which components rendered,
 *   3. times the calculator API for each page,
 *   4. pushes the results to the collector (/api/telemetry) as Crawl* events.
 *
 * This is a fetch-based crawler: it reads the server-rendered HTML, so it can
 * measure load time, component presence and API timing without a browser. (For
 * client-side render durations and CTA-redirect timing, the report uses the RUM
 * events the page instrumentation sends while you browse — see the report.)
 *
 * Run:  npm run crawl        (needs `npm run dev` running)
 * Env:  BASE_URL (default http://localhost:3000)
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const CONCURRENCY = 5

// The components we expect on every fund page (must match data-nr-component=…).
const EXPECTED_COMPONENTS = [
  'fund-header', 'returns-summary', 'nav-chart',
  'fund-details-table', 'sip-calculator', 'risk-gauge',
]

const round = (n) => Math.round(n)

/** Crawl a single page and return the telemetry events it produced. */
async function crawlPage(slug) {
  const events = []
  const pageUrl = `${BASE_URL}/investments/${slug}?next=true`

  // 1. Load the page, timing the request.
  const startedAt = performance.now()
  let html = ''
  let httpStatus = 0
  try {
    const response = await fetch(pageUrl)
    httpStatus = response.status
    html = await response.text()
  } catch {
    httpStatus = 0
  }
  const loadMs = round(performance.now() - startedAt)

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
    status: httpStatus >= 200 && httpStatus < 400 ? 'ok' : 'http_error',
    httpStatus,
    loadMs,
    jsErrors: 0,
  })

  // 4. Time the calculator API the page depends on.
  const apiStartedAt = performance.now()
  let apiStatus = 0
  try {
    const apiResponse = await fetch(`${BASE_URL}/api/funds/sip-calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthly: 25000, years: 2, rate: 15 }),
    })
    apiStatus = apiResponse.status
  } catch {
    apiStatus = 0
  }
  events.push({
    eventType: 'CrawlApiMetric',
    pageType: 'mf-detail',
    fundSlug: slug,
    endpoint: '/api/funds/sip-calculate',
    durationMs: round(performance.now() - apiStartedAt),
    httpStatus: apiStatus,
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
  console.log(`Crawler starting against ${BASE_URL}`)

  // Discover the pages to crawl from the slug API.
  const slugsResponse = await fetch(`${BASE_URL}/api/funds/slugs`)
  const { slugs } = await slugsResponse.json()
  console.log(`Discovered ${slugs.length} slugs`)

  // Crawl with a small concurrency pool (a shared cursor consumed by N workers).
  let cursor = 0
  let pagesDone = 0
  const allEvents = []

  const worker = async () => {
    while (cursor < slugs.length) {
      const slug = slugs[cursor++]
      const events = await crawlPage(slug)
      allEvents.push(...events)
      pagesDone++
      process.stdout.write(`\r  crawled ${pagesDone}/${slugs.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slugs.length) }, worker))

  // Ship everything to the collector.
  await sendToCollector(allEvents)
  console.log(`\nDone — ${pagesDone} pages, ${allEvents.length} events sent to the collector.`)
  console.log('Next: npm run report')
}

main().catch((error) => {
  console.error('\nCrawl failed:', error.message)
  console.error('Is the dev server running?  npm run dev')
  process.exit(1)
})
