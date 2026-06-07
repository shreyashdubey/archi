/**
 * Core instrumentation (framework-agnostic). This is the mock equivalent of the
 * New Relic Browser agent: it captures component renders, API call timings and
 * CTA→redirect timings, then ships them to a collector.
 *
 * Where do the events go?
 *   1. console      — so you can watch them live in DevTools.
 *   2. window.__NR_EVENTS__ — so you can inspect them programmatically.
 *   3. /api/telemetry — the real "sink" (our stand-in for NRDB). The crawler and
 *      the daily-report script both read from that same store.
 */
export type Attrs = Record<string, unknown>

/** The New Relic Browser agent, if a real one is present on the page. */
type NewRelicAgent = {
  addPageAction?: (name: string, attrs: Attrs) => void
  setCustomAttribute?: (key: string, value: unknown) => void
}
const getNewRelicAgent = (): NewRelicAgent | undefined =>
  typeof window !== 'undefined' ? (window as any).newrelic : undefined

/** Endpoint that collects telemetry (our NRDB stand-in). */
const COLLECTOR_URL = '/api/telemetry'

/** Attributes attached to every event (pageType, fundSlug, …). */
let globalDimensions: Attrs = {}

/** Set the page-level dimensions every event should carry. */
export function setDimensions(dimensions: Attrs): void {
  globalDimensions = { ...globalDimensions, ...dimensions }
  const agent = getNewRelicAgent()
  if (agent?.setCustomAttribute) {
    for (const [key, value] of Object.entries(dimensions)) agent.setCustomAttribute(key, value)
  }
}

/** Record one telemetry event and fan it out to every sink. */
export function reportEvent(eventType: string, attributes: Attrs): void {
  const event = { eventType, ...globalDimensions, ...attributes, ts: Date.now() }

  // 1. Real New Relic agent (production) — no-op in the mock.
  getNewRelicAgent()?.addPageAction?.(eventType, event)

  if (typeof window !== 'undefined') {
    // 2. In-memory buffer for inspection.
    ;((window as any).__NR_EVENTS__ ||= []).push(event)
    // 3. Send to the collector (NRDB stand-in) for the crawler/report to read.
    sendToCollector(event)
  }

  // Visible locally: open DevTools console to watch the telemetry stream.
  if (typeof console !== 'undefined') {
    console.debug('%c[NR] ' + eventType, 'color:#0b6;font-weight:600', event)
  }
}

/**
 * Ship one event to the collector. Uses sendBeacon (not fetch) on purpose —
 * sendBeacon bypasses our fetch wrapper below, so telemetry never re-instruments
 * itself into an infinite loop.
 */
function sendToCollector(event: Attrs): void {
  try {
    const payload = JSON.stringify([event])
    if (navigator.sendBeacon) {
      navigator.sendBeacon(COLLECTOR_URL, new Blob([payload], { type: 'application/json' }))
    }
  } catch {
    /* telemetry must never break the page */
  }
}

/** Strip dynamic ids/query so endpoints group into one row in the report. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, typeof location !== 'undefined' ? location.origin : 'http://localhost')
    return parsed.pathname.replace(/\/[a-z0-9-]{12,}/gi, '/:id')
  } catch {
    return url
  }
}

/**
 * Time every fetch as an `ApiCall` event. (A real New Relic agent captures these
 * as `AjaxRequest` automatically; we do it by hand so the mock is self-contained.)
 */
export function installFetchTiming(): void {
  if (typeof window === 'undefined' || (window as any).__nrFetchPatched) return
  ;(window as any).__nrFetchPatched = true

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (...fetchArgs: Parameters<typeof fetch>) => {
    const requestUrl = typeof fetchArgs[0] === 'string' ? fetchArgs[0] : (fetchArgs[0] as Request).url

    // Don't time (or re-report) calls to the collector itself.
    if (requestUrl.includes(COLLECTOR_URL)) return originalFetch(...fetchArgs)

    const startTime = performance.now()
    try {
      const response = await originalFetch(...fetchArgs)
      reportEvent('ApiCall', {
        endpoint: normalizeUrl(requestUrl),
        durationMs: Math.round(performance.now() - startTime),
        httpStatus: response.status,
      })
      return response
    } catch (error) {
      reportEvent('ApiCall', {
        endpoint: normalizeUrl(requestUrl),
        durationMs: Math.round(performance.now() - startTime),
        httpStatus: 0,
        error: String(error),
      })
      throw error
    }
  }
}

/**
 * Install the global listeners that don't belong to any single component:
 *   - Element Timing API  → ComponentRender (render latency of markup blocks)
 *   - CTA click           → stamp the click time so the next page can measure it
 *   - page load           → CtaRedirect (click-to-destination-ready, cross-page)
 */
export function installGlobals(): void {
  if (typeof window === 'undefined' || (window as any).__nrGlobals) return
  ;(window as any).__nrGlobals = true

  // Component render latency, reported by the browser's Element Timing API.
  if ('PerformanceObserver' in window) {
    try {
      const elementTimingObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (entry.identifier) {
            reportEvent('ComponentRender', {
              component: entry.identifier,
              status: 'rendered',
              renderMs: Math.round(entry.renderTime || entry.loadTime),
            })
          }
        }
      })
      elementTimingObserver.observe({ type: 'element', buffered: true } as any)
    } catch {
      /* Element Timing unsupported in this browser */
    }
  }

  // When a CTA is clicked, remember which one and when (survives the navigation).
  document.addEventListener(
    'click',
    (clickEvent) => {
      const ctaElement = (clickEvent.target as HTMLElement)?.closest?.('[data-nr-cta]') as HTMLElement | null
      if (!ctaElement) return
      const ctaName = ctaElement.getAttribute('data-nr-cta')!
      try {
        sessionStorage.setItem('nr_cta', JSON.stringify({ cta: ctaName, clickedAt: Date.now(), fromPath: location.pathname }))
      } catch {
        /* sessionStorage may be unavailable */
      }
      reportEvent('CtaClick', { cta: ctaName, fromPath: location.pathname })
    },
    true,
  )

  // On the destination page, turn the stamped click into a redirect duration.
  window.addEventListener('load', () => {
    let storedClick: string | null = null
    try {
      storedClick = sessionStorage.getItem('nr_cta')
    } catch {
      return
    }
    if (!storedClick) return
    try {
      sessionStorage.removeItem('nr_cta')
    } catch {
      /* ignore */
    }

    const click = JSON.parse(storedClick) as { cta: string; clickedAt: number; fromPath: string }
    const elapsedSinceClick = click?.clickedAt ? Date.now() - click.clickedAt : Infinity
    if (!click || elapsedSinceClick < 0 || elapsedSinceClick > 60_000) return // stale/unrelated nav

    const navigationTiming = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const destinationReadyEpoch = performance.timeOrigin + (navigationTiming?.domContentLoadedEventEnd ?? 0)
    const redirectMs = Math.round(destinationReadyEpoch - click.clickedAt)
    if (redirectMs > 0) {
      reportEvent('CtaRedirect', { cta: click.cta, redirectMs, fromPath: click.fromPath, toPath: location.pathname })
    }
  })
}
