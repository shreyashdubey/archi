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
 * Env:   NR_ACCOUNT_ID, NR_INSERT_KEY, NR_INSIGHTS_BASE_URL, INVESTMENTS_BASE_URL, PAGE_TYPE, CONCURRENCY
 */
import { chromium, type Browser, type BrowserContext } from 'playwright'

// Base for the monitored URL pattern: `${INVESTMENTS_BASE_URL}${slug}?next=true`.
const INVESTMENTS_BASE_URL = process.env.INVESTMENTS_BASE_URL ?? 'https://www.bajajfinserv.in/investments/'
const PAGE_TYPE = process.env.PAGE_TYPE ?? 'mf-detail'
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4)
const PAGE_TIMEOUT_MS = 30_000
// New Relic Event API host (US default; use insights-collector.eu01.nr-data.net for EU).
const NR_INSIGHTS_BASE_URL = process.env.NR_INSIGHTS_BASE_URL ?? 'https://insights-collector.newrelic.com'
const NR_EVENT_API = `${NR_INSIGHTS_BASE_URL}/v1/accounts/${process.env.NR_ACCOUNT_ID}/events`

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
  const fundSlugs = input.slugs ?? []
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const collectedEvents: CrawlEvent[] = []

  // Concurrency pool: N workers share a cursor over the slug list.
  let nextSlugIndex = 0
  const crawlWorker = async () => {
    while (nextSlugIndex < fundSlugs.length) {
      const fundSlug = fundSlugs[nextSlugIndex++]
      collectedEvents.push(...(await crawlOneWithTimeout(browser, fundSlug)))
    }
  }
  const workerCount = Math.min(CONCURRENCY, fundSlugs.length)
  await Promise.all(Array.from({ length: workerCount }, crawlWorker))

  await browser.close()
  await pushEventsToNewRelic(collectedEvents)
  console.log(`Crawled ${fundSlugs.length} slugs -> ${collectedEvents.length} events`)
  return { crawled: fundSlugs.length, events: collectedEvents.length }
}

/** Crawl one page, but never let a single stuck page stall the whole chunk. */
async function crawlOneWithTimeout(browser: Browser, slug: string): Promise<CrawlEvent[]> {
  const overallTimeoutMs = PAGE_TIMEOUT_MS + 5_000
  const timeoutGuard = new Promise<CrawlEvent[]>((resolve) =>
    setTimeout(
      () => resolve([{ eventType: 'CrawlPageMetric', pageType: PAGE_TYPE, fundSlug: slug, status: 'timeout' }]),
      overallTimeoutMs,
    ),
  )
  const crawlAttempt = crawlOne(browser, slug).catch((crawlError) => [
    { eventType: 'CrawlPageMetric', pageType: PAGE_TYPE, fundSlug: slug, status: 'crawl_error', errorMessage: String(crawlError) },
  ])
  return Promise.race([crawlAttempt, timeoutGuard])
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
  const apiTimingsByEndpoint: Record<string, { durationMs: number; status: number }> = {}
  page.on('response', (response) => {
    const request = response.request()
    const resourceType = request.resourceType()
    if (resourceType !== 'xhr' && resourceType !== 'fetch') return
    const requestTiming = request.timing()
    apiTimingsByEndpoint[normalizeEndpoint(request.url())] = {
      durationMs: Math.round(requestTiming.responseEnd - requestTiming.requestStart),
      status: response.status(),
    }
  })

  // 1. Load the page (the URL follows the /investments/{slug}-growth pattern).
  const loadStartedAt = Date.now()
  const pageResponse = await page.goto(`${INVESTMENTS_BASE_URL}${slug}?next=true`, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
  const loadMs = Date.now() - loadStartedAt

  // 2. Read CWV + per-component element-timing from inside the page, once.
  const inPageMetrics = await page.evaluate(() => {
    const navigationTiming = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const largestContentfulPaint = performance.getEntriesByType('largest-contentful-paint').at(-1) as any
    const renderMsByComponent: Record<string, number> = {}
    for (const elementTiming of performance.getEntriesByType('element') as any[]) {
      if (elementTiming.identifier) {
        renderMsByComponent[elementTiming.identifier] = Math.round(elementTiming.renderTime || elementTiming.loadTime)
      }
    }
    return {
      domContentLoaded: navigationTiming ? Math.round(navigationTiming.domContentLoadedEventEnd) : null,
      lcp: largestContentfulPaint ? Math.round(largestContentfulPaint.renderTime) : null,
      componentRenderMs: renderMsByComponent,
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
    status: pageResponse?.ok() ? 'ok' : 'http_error',
    httpStatus: pageResponse?.status() ?? 0,
    loadMs,
    domContentLoaded: inPageMetrics.domContentLoaded,
    lcp: inPageMetrics.lcp,
    jsErrors: jsErrorCount,
  })

  // 5. One metric per API endpoint that was called.
  for (const [endpoint, apiTiming] of Object.entries(apiTimingsByEndpoint)) {
    events.push({ eventType: 'CrawlApiMetric', ...baseAttributes, endpoint, durationMs: apiTiming.durationMs, httpStatus: apiTiming.status })
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

const MAX_EVENTS_PER_REQUEST = 1000 // New Relic Event API per-request cap
// Parse a numeric env knob, falling back for unset/empty/non-numeric/below-min
// values — so a typo can't, e.g., zero out the retry loop and silently drop a batch.
const intEnv = (name: string, fallback: number, min: number): number => {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}
const PUSH_MAX_ATTEMPTS = intEnv('NR_PUSH_MAX_ATTEMPTS', 4, 1) // always >= 1 attempt
const PUSH_BACKOFF_MS = intEnv('NR_PUSH_BACKOFF_MS', 250, 0)
const PUSH_TIMEOUT_MS = intEnv('NR_PUSH_TIMEOUT_MS', 15_000, 1)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Batch-push events to the New Relic Event API (<=1000 per request). Each batch
 * is retried with backoff on a transient failure (network error, 429, or 5xx);
 * a 4xx (bad key/payload) fails fast. If a batch can't be delivered, we THROW so
 * the chunk is marked failed and the orchestrator (Step Functions / SQS) retries
 * it — telemetry is never silently dropped, keeping coverage honest.
 *
 * Note: for very large chunks (Fargate, hundreds of pages) prefer flushing per
 * page from the worker pool so memory stays bounded and a crash loses less.
 */
async function pushEventsToNewRelic(events: CrawlEvent[]): Promise<void> {
  for (let batchStartIndex = 0; batchStartIndex < events.length; batchStartIndex += MAX_EVENTS_PER_REQUEST) {
    const batch = events.slice(batchStartIndex, batchStartIndex + MAX_EVENTS_PER_REQUEST)
    await pushBatchWithRetry(batch, `events ${batchStartIndex}–${batchStartIndex + batch.length}`)
  }
}

/** Deliver one batch, retrying transient failures with exponential backoff. */
async function pushBatchWithRetry(batch: CrawlEvent[], label: string): Promise<void> {
  for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
    let isTransient = false
    // Abort a stalled connection so a hung push can't block the chunk forever.
    const abortController = new AbortController()
    const abortTimer = setTimeout(() => abortController.abort(), PUSH_TIMEOUT_MS)
    try {
      const response = await fetch(NR_EVENT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Key': process.env.NR_INSERT_KEY! },
        body: JSON.stringify(batch),
        signal: abortController.signal,
      })
      if (response.ok) return
      const responseBody = await response.text()
      // 4xx (bad insert key / payload) won't succeed on retry — fail loudly now.
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`NR Event API rejected ${label}: HTTP ${response.status} ${responseBody}`)
      }
      isTransient = true // 429 / 5xx — retry
      if (attempt >= PUSH_MAX_ATTEMPTS) throw new Error(`NR Event API ${label}: HTTP ${response.status} after ${attempt} attempts`)
    } catch (error) {
      // Transient: a 429/5xx (above), our timeout (AbortError), or a network failure (TypeError).
      const transient = isTransient || error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')
      if (!transient || attempt >= PUSH_MAX_ATTEMPTS) throw error
    } finally {
      clearTimeout(abortTimer)
    }
    await sleep(PUSH_BACKOFF_MS * 2 ** (attempt - 1)) // 250ms, 500ms, 1s, …
  }
}
