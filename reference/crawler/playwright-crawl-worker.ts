/**
 * playwright-crawl-worker.ts — crawls a CHUNK of fund pages with a real browser
 * and measures, per page: load timing, Core Web Vitals, each component
 * (rendered? + renderMs), each API call time, each CTA redirect time, and JS
 * errors. Results are pushed to the New Relic Event API (queryable next to RUM).
 *
 * Monitored surface: pages at the URL pattern /investments/{slug}-growth.
 * Every event is tagged pageType='mf-detail' so the fleet digest can query them.
 *
 * Run as a Fargate task, or a Lambda invoked per-chunk by Step Functions Map.
 * Deps: playwright (or @sparticuz/chromium + playwright-core on Lambda).
 *
 * Input: { slugs: string[] }   (slugs end in "-growth")
 * Env:   NR_ACCOUNT_ID, NR_INSERT_KEY, INVESTMENTS_BASE_URL, PAGE_TYPE, CONCURRENCY
 */
import { chromium, type Browser, type BrowserContext } from 'playwright'

// Base for the monitored URL pattern: `${INVESTMENTS_BASE_URL}${slug}?next=true`.
const INVESTMENTS_BASE_URL = process.env.INVESTMENTS_BASE_URL ?? 'https://app.bajajfinserv.in/investments/'
const PAGE_TYPE = process.env.PAGE_TYPE ?? 'mf-detail'
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4)
const PAGE_TIMEOUT_MS = 30_000
const NR_EVENT_API = `https://insights-collector.newrelic.com/v1/accounts/${process.env.NR_ACCOUNT_ID}/events`

// The components we expect on every fund page (must match data-nr-component=…).
const EXPECTED_COMPONENTS = [
  'fund-header', 'returns-summary', 'nav-chart',
  'fund-details-table', 'sip-calculator', 'risk-gauge',
] as const
const EXPECTED_CTAS = ['open-mf-account'] as const

/** Anything we send to the New Relic Event API needs an `eventType`. */
interface CrawlEvent {
  eventType: string
  [field: string]: unknown
}

export const handler = async (input: { slugs: string[] }): Promise<{ crawled: number; events: number }> => {
  const slugs = input.slugs ?? []
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const collectedEvents: CrawlEvent[] = []

  // Concurrency pool: N workers share a cursor over the slug list.
  let nextSlugIndex = 0
  const crawlWorker = async () => {
    while (nextSlugIndex < slugs.length) {
      const slug = slugs[nextSlugIndex++]
      collectedEvents.push(...(await crawlOneWithTimeout(browser, slug)))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slugs.length) }, crawlWorker))

  await browser.close()
  await pushEventsToNewRelic(collectedEvents)
  console.log(`Crawled ${slugs.length} slugs -> ${collectedEvents.length} events`)
  return { crawled: slugs.length, events: collectedEvents.length }
}

/** Crawl one page, but never let a single stuck page stall the whole chunk. */
async function crawlOneWithTimeout(browser: Browser, slug: string): Promise<CrawlEvent[]> {
  const timeoutGuard = new Promise<CrawlEvent[]>((resolve) =>
    setTimeout(
      () => resolve([{ eventType: 'CrawlPageMetric', pageType: PAGE_TYPE, fundSlug: slug, status: 'timeout' }]),
      PAGE_TIMEOUT_MS + 5_000,
    ),
  )
  const crawl = crawlOne(browser, slug).catch((error) => [
    { eventType: 'CrawlPageMetric', pageType: PAGE_TYPE, fundSlug: slug, status: 'crawl_error', errorMessage: String(error) },
  ])
  return Promise.race([crawl, timeoutGuard])
}

async function crawlOne(browser: Browser, slug: string): Promise<CrawlEvent[]> {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const baseAttributes = { pageType: PAGE_TYPE, fundSlug: slug }
  const events: CrawlEvent[] = []

  // Count JS errors on the page.
  let jsErrorCount = 0
  page.on('pageerror', () => { jsErrorCount++ })
  page.on('console', (message) => { if (message.type() === 'error') jsErrorCount++ })

  // Capture API timing from the `response` event (timing is ready by then —
  // no awaiting inside the handler, so no race with page settle).
  const apiTimings: Record<string, { durationMs: number; status: number }> = {}
  page.on('response', (response) => {
    const request = response.request()
    if (request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return
    const timing = request.timing()
    apiTimings[normalizeEndpoint(request.url())] = {
      durationMs: Math.round(timing.responseEnd - timing.requestStart),
      status: response.status(),
    }
  })

  // 1. Load the page (the URL follows the /investments/{slug}-growth pattern).
  const loadStartedAt = Date.now()
  const response = await page.goto(`${INVESTMENTS_BASE_URL}${slug}?next=true`, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
  const loadMs = Date.now() - loadStartedAt

  // 2. Read CWV + per-component element-timing from inside the page, once.
  const inPageMetrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const largestContentfulPaint = performance.getEntriesByType('largest-contentful-paint').at(-1) as any
    const componentRenderMs: Record<string, number> = {}
    for (const entry of performance.getEntriesByType('element') as any[]) {
      if (entry.identifier) componentRenderMs[entry.identifier] = Math.round(entry.renderTime || entry.loadTime)
    }
    return {
      domContentLoaded: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
      lcp: largestContentfulPaint ? Math.round(largestContentfulPaint.renderTime) : null,
      componentRenderMs,
    }
  })

  // 3. Per-component: present and visible? how fast did it render?
  for (const component of EXPECTED_COMPONENTS) {
    const isVisible = await page.locator(`[data-nr-component="${component}"]`).first().isVisible().catch(() => false)
    events.push({
      eventType: 'CrawlComponentMetric',
      ...baseAttributes,
      component,
      status: isVisible ? 'rendered' : 'missing',
      renderMs: inPageMetrics.componentRenderMs[component] ?? null,
    })
  }

  // 4. Page-level metric.
  events.push({
    eventType: 'CrawlPageMetric',
    ...baseAttributes,
    status: response?.ok() ? 'ok' : 'http_error',
    httpStatus: response?.status() ?? 0,
    loadMs,
    domContentLoaded: inPageMetrics.domContentLoaded,
    lcp: inPageMetrics.lcp,
    jsErrors: jsErrorCount,
  })

  // 5. One metric per API endpoint that was called.
  for (const [endpoint, timing] of Object.entries(apiTimings)) {
    events.push({ eventType: 'CrawlApiMetric', ...baseAttributes, endpoint, durationMs: timing.durationMs, httpStatus: timing.status })
  }

  // 6. CTA → redirect timing (after measuring load, so it doesn't pollute it).
  for (const cta of EXPECTED_CTAS) {
    const ctaLocator = page.locator(`[data-nr-cta="${cta}"]`).first()
    if (await ctaLocator.isVisible().catch(() => false)) {
      const clickedAt = Date.now()
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}),
        ctaLocator.click({ timeout: 5_000 }).catch(() => {}),
      ])
      events.push({ eventType: 'CrawlCtaMetric', ...baseAttributes, cta, redirectMs: Date.now() - clickedAt })
    }
  }

  await context.close()
  return events
}

/** Strip dynamic ids/query so endpoints group into one row in the report. */
function normalizeEndpoint(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/[a-z0-9-]{12,}/gi, '/:id')
  } catch {
    return url
  }
}

/** Batch-push events to the New Relic Event API (<=1000 per request). */
async function pushEventsToNewRelic(events: CrawlEvent[]): Promise<void> {
  for (let offset = 0; offset < events.length; offset += 1000) {
    const batch = events.slice(offset, offset + 1000)
    const response = await fetch(NR_EVENT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': process.env.NR_INSERT_KEY! },
      body: JSON.stringify(batch),
    })
    if (!response.ok) console.error('NR Event API error', response.status, await response.text())
  }
}
