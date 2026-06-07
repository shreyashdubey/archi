# Wiring New Relic into Next.js + the Synthetics monitor

Covers the three data sources from the architecture: **APM (server)**, **Browser (RUM)**, and a
**Synthetics** monitor for the page.

---

## 1. APM — Node agent (server-side SSR / API routes)

Install the agent and a New Relic config.

```bash
npm i newrelic @newrelic/next
```

`newrelic.js` (or set the equivalent `NEW_RELIC_*` env vars):

```js
'use strict'
exports.config = {
  app_name: ['nextjs-app'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  distributed_tracing: { enabled: true },
  logging: { level: 'info' },
  application_logging: { forwarding: { enabled: true } },
  // Name the page transaction so NRQL/alerts can target it precisely:
  // shows up as WebTransaction/Nextjs/investments/[slug]
}
```

Load the agent before app code. With the App Router, use `instrumentation.ts` at the project root:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('newrelic')
  }
}
```

Enable it in `next.config.js`:

```js
// next.config.js
module.exports = {
  experimental: { instrumentationHook: true }, // (stable in newer Next versions)
  serverExternalPackages: ['newrelic'],
}
```

> Alternatively start the process with `NODE_OPTIONS='-r newrelic' next start`.

Optionally tag the specific page transaction in a server component / route handler:

```ts
import newrelic from 'newrelic'
newrelic.setTransactionName('Nextjs/mf-detail')
newrelic.addCustomAttribute('pageType', 'mf-detail')
```

---

## 2. Browser agent — RUM / Core Web Vitals

Get the **copy/paste browser snippet** from New Relic (Browser → Add data → Copy/Paste). Inject it
as early as possible in the root layout so it captures the full page load.

```tsx
// app/layout.tsx
import Script from 'next/script'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Paste the New Relic Browser loader snippet here */}
        <Script id="nr-browser" strategy="beforeInteractive">
          {`/* ...New Relic browser agent loader... */`}
        </Script>
      </head>
      <body>{children}</body>
    </html>
  )
}
```

Name the page route on the client so `PageView`/`PageViewTiming` can be filtered cleanly:

```tsx
'use client'
import { useEffect } from 'react'

export function NewRelicPageName({ name }: { name: string }) {
  useEffect(() => {
    // @ts-expect-error injected by the browser agent
    window.newrelic?.setPageViewName(name)
  }, [name])
  return null
}
// Use in the fund page: <NewRelicPageName name="mf-detail" />
```

This populates `PageViewTiming.largestContentfulPaint`, `interactionToNextPaint`,
`cumulativeLayoutShift` for the report's Core Web Vitals.

---

## 3. Synthetics — scripted browser monitor for the page

Create a **Scripted Browser** monitor (Synthetics → Create monitor). Run every **1 minute** from
**≥3 locations**. It asserts both reachability *and* a key element exists (functional check).

```js
// New Relic Synthetics scripted browser ($browser is the Selenium-WebDriver instance)
const assert = require('assert')

$webDriver.get('https://app.bajajfinserv.in/investments/nippon-india-taiwan-equity-fund-g-growth').then(() => {
  // 1) HTTP-level reachability is handled by the monitor itself.
  // 2) Functional check: the primary CTA must render within 10s.
  return $webDriver.wait(
    $selenium.until.elementLocated($selenium.By.css('[data-nr-cta="open-mf-account"]')),
    10000,
    'OPEN MF ACCOUNT button not found — page degraded/broken'
  )
}).then((el) => {
  return el.isDisplayed().then((visible) => {
    assert.ok(visible, 'OPEN MF ACCOUNT button present but not visible')
  })
})
```

A simple **ping** monitor is the cheaper minimum if you only need 2xx reachability; the scripted
browser additionally catches *functional* degradation (page loads but the CTA is gone).

---

## 4. Result

- Server timing/errors → `Transaction` / `TransactionError` (APM)
- Real-user CWV/JS errors → `PageView` / `PageViewTiming` (Browser)
- Synthetic availability → `SyntheticCheck` / `SyntheticRequest` (Synthetics)

All land in NRDB and are queried by the alert conditions and the Lambda report (see
`../nrql/single-page-alerts-and-report.nrql`).
