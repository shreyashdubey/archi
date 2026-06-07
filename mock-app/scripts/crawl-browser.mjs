/**
 * scripts/crawl-browser.mjs — BROWSER-RENDERED crawler (real client render times).
 *
 * Unlike scripts/crawl.mjs (fetch-based: server HTML only, renderMs is null and
 * the load number is just the fetch time), this drives a REAL browser, so it
 * captures what an actual user's session would:
 *   - ComponentRender renderMs   (React mount + Element Timing + data-ready timing)
 *   - ApiCall round-trip          (the SIP calculator fetches on mount)
 *   - page load                   (Navigation Timing, not fetch time)
 *   - component coverage          (present/missing in the live DOM)
 *
 * It renders every page CRAWL_SAMPLES times so the report has a real distribution
 * to take percentiles over (and the fleet "avg page load" is a true multi-sample mean).
 *
 * How it works: launches the system Google Chrome headless and talks the Chrome
 * DevTools Protocol over Node's built-in WebSocket — no Playwright/Puppeteer
 * dependency, no browser download. The page's own instrumentation produces the
 * RUM events; we stub navigator.sendBeacon so the page can't double-send, read
 * window.__NR_EVENTS__ directly, and POST one controlled batch to the collector.
 *
 * Run:  npm run dev   (in another terminal), then   npm run crawl:browser
 * Env:  BASE_URL          (the mock's URL; auto-detected across ports 3000–3003 if unset)
 *       PORT               (the mock's port, if pinned; default probes 3000–3003)
 *       SAMPLE_SIZE        (random pages to render; default 25, 0 = all ~6,000)
 *       SAMPLE_SEED        (fix the random sample for a reproducible run)
 *       CRAWL_SAMPLES      (renders per page, default 3)
 *       CRAWL_SETTLE_MS    (wait after load for render/calc to finish, default 1800)
 *       RESET_STORE        (if set, empty the event store first — clean run)
 *       CHROME_PATH        (override the Chrome binary)
 *       CRAWL_DEBUG_PORT   (CDP port, default 9333)
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearEvents } from '@mock/telemetry'
import { resolveBaseUrl, discoverSlugs, sampleSlugs, getSampleConfig } from './lib/discover.mjs'

let BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const SAMPLES = Math.max(1, Number(process.env.CRAWL_SAMPLES ?? 3))
const SETTLE_MS = Number(process.env.CRAWL_SETTLE_MS ?? 1800)
const NAV_TIMEOUT_MS = 30_000
const DEBUG_PORT = Number(process.env.CRAWL_DEBUG_PORT ?? 9333)
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Per-command CDP timeout so a stuck protocol call can never hang the whole run.
const CDP_TIMEOUT_MS = Number(process.env.CRAWL_CDP_TIMEOUT_MS ?? 20_000)
const DEBUG = !!process.env.CRAWL_DEBUG
const debug = (...args) => { if (DEBUG) console.error('[cdp]', ...args) }

// Must match the data-nr-component attributes the page renders.
const EXPECTED_COMPONENTS = ['fund-header', 'returns-summary', 'nav-chart', 'fund-details-table', 'sip-calculator', 'risk-gauge']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs IN THE PAGE: collect the events the instrumentation buffered + load + coverage. */
function pageProbe(expected) {
  const nav = performance.getEntriesByType('navigation')[0] || {}
  const loadMs = Math.round(nav.duration || nav.loadEventEnd || performance.now())
  const present = expected.filter((c) => !!document.querySelector('[data-nr-component="' + c + '"]'))
  return JSON.stringify({ events: window.__NR_EVENTS__ || [], loadMs, present })
}

// --- minimal Chrome DevTools Protocol client over the built-in WebSocket ------
class CDP {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    ws.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '')
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return // ignore non-JSON frames
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        debug('event', msg.method)
        for (const listener of this.listeners) listener(msg)
      }
    })
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
    debug('send', method)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${CDP_TIMEOUT_MS}ms`))
      }, CDP_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(payload))
    })
  }
  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  waitFor(method, sessionId, timeoutMs = NAV_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const off = this.on((msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          off()
          clearTimeout(timer)
          resolve(msg)
        }
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
    })
  }
}

/** Wait for Chrome's debugger endpoint, then open a WebSocket to it. */
async function connectBrowser(port) {
  let info
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      if (info.webSocketDebuggerUrl) break
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  if (!info?.webSocketDebuggerUrl) throw new Error('Chrome did not expose a DevTools endpoint')
  const ws = new WebSocket(info.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('failed to open DevTools WebSocket')), { once: true })
  })
  return new CDP(ws)
}

async function main() {
  BASE_URL = await resolveBaseUrl()

  if (process.env.RESET_STORE) {
    await clearEvents()
    console.log('Cleared the event store (RESET_STORE) — report will reflect this run only.')
  }

  const { slugs: discovered, total, source } = await discoverSlugs(BASE_URL)
  const { size, seed } = getSampleConfig()
  const slugs = sampleSlugs(discovered, size, { seed })
  console.log(`Crawler (browser) against ${BASE_URL}`)
  console.log(`Discovered ${total} slugs (source: ${source}) — rendering ${slugs.length} × ${SAMPLES} samples in a real browser`)

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'mock-crawl-'))
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  const batch = []
  try {
    const cdp = await connectBrowser(DEBUG_PORT)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    // The page beacons each event to the collector; stub it so WE own what's sent
    // (read window.__NR_EVENTS__ and POST once) and never double-count.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'navigator.sendBeacon = function () { return true }' }, sessionId)

    // Capture the main document's HTTP status for each navigation.
    let docStatus = 0
    cdp.on((msg) => {
      if (msg.method === 'Network.responseReceived' && msg.sessionId === sessionId && msg.params?.type === 'Document') {
        docStatus = msg.params.response?.status ?? docStatus
      }
    })

    let pagesDone = 0
    for (const slug of slugs) {
      const url = `${BASE_URL}/investments/${slug}?next=true`
      for (let sample = 1; sample <= SAMPLES; sample++) {
        docStatus = 0
        try {
          const loaded = cdp.waitFor('Page.loadEventFired', sessionId)
          const nav = await cdp.send('Page.navigate', { url }, sessionId)
          if (nav.errorText) throw new Error(nav.errorText)
          await loaded
        } catch {
          batch.push({ eventType: 'CrawlPageMetric', pageType: 'mf-detail', fundSlug: slug, status: 'http_error', httpStatus: 0, loadMs: 0, jsErrors: 0, source: 'browser-crawl', sample })
          continue
        }
        await sleep(SETTLE_MS) // let React mount, Element Timing fire, and the SIP calc resolve

        const evalRes = await cdp.send(
          'Runtime.evaluate',
          { expression: `(${pageProbe.toString()})(${JSON.stringify(EXPECTED_COMPONENTS)})`, returnByValue: true },
          sessionId,
        )
        if (evalRes.exceptionDetails) {
          batch.push({ eventType: 'CrawlPageMetric', pageType: 'mf-detail', fundSlug: slug, status: 'http_error', httpStatus: docStatus || 0, loadMs: 0, jsErrors: 1, source: 'browser-crawl', sample })
          continue
        }
        const data = JSON.parse(evalRes.result.value)
        const httpStatus = docStatus || 200

        // 1. Real RUM the page produced this load (ComponentRender renderMs, ApiCall).
        for (const event of data.events) {
          if (event.eventType === 'ComponentRender' || event.eventType === 'ApiCall') {
            batch.push({ ...event, source: 'browser-crawl' })
          }
        }
        // 2. Coverage (present/missing in the live DOM) — one per expected component.
        for (const component of EXPECTED_COMPONENTS) {
          batch.push({ eventType: 'CrawlComponentMetric', pageType: 'mf-detail', fundSlug: slug, component, status: data.present.includes(component) ? 'rendered' : 'missing', renderMs: null, source: 'browser-crawl' })
        }
        // 3. Page-level load (real browser Navigation Timing, per sample).
        batch.push({ eventType: 'CrawlPageMetric', pageType: 'mf-detail', fundSlug: slug, status: httpStatus >= 200 && httpStatus < 400 ? 'ok' : 'http_error', httpStatus, loadMs: data.loadMs, jsErrors: 0, source: 'browser-crawl', sample })
      }
      pagesDone++
      console.log(`  rendered ${pagesDone}/${slugs.length}`)
    }
  } finally {
    try {
      chrome.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }

  await fetch(`${BASE_URL}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })
  const renderSamples = batch.filter((e) => e.eventType === 'ComponentRender').length
  const apiSamples = batch.filter((e) => e.eventType === 'ApiCall').length
  console.log(`\nDone — ${slugs.length} pages × ${SAMPLES} samples → ${batch.length} events sent (${renderSamples} real ComponentRender, ${apiSamples} ApiCall).`)
  console.log('Next: npm run report')
}

main().catch((error) => {
  console.error('\nBrowser crawl failed:', error.message)
  console.error(`Could not reach the mock at ${BASE_URL} (npm run dev), or Google Chrome isn't at CHROME_PATH.`)
  console.error('(If port 3000 is busy, Next uses another port — set BASE_URL=http://localhost:<port> or PORT=<port>.)')
  process.exit(1)
})
