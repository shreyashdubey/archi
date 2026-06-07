# mock-app — dynamic fund-detail template (monitoring mock)

A minimal Next.js (App Router) mock of the Bajaj Finserv fund page. It reproduces
the real setup for the monitoring architecture:

- **Dynamic slug route** `/investments/{slug}-growth` renders **any** slug (stands in
  for the 6,000 pages) from slug-seeded mock data — no real backend needed.
- **All components live in `packages/`**; the `app/` folder only has `layout.tsx`
  and the dynamic `page.tsx` (plus two mock API routes — endpoints, not pages).
- **Instrumentation is wired in** exactly like the architecture describes, and in
  the mock it **logs telemetry to the browser console** (and `window.__NR_EVENTS__`)
  so you can watch ComponentRender / ApiCall / CtaClick / CtaRedirect events live.

## Layout

```
app/
  layout.tsx                         # root: installs global instrumentation
  investments/[slug]/page.tsx        # the ONLY page — resolves data, renders <PageShell/>
  api/funds/slugs/route.ts           # mock "slug API"
  api/funds/sip-calculate/route.ts   # mock calc API (fetched by the calculator)
packages/
  data/            @mock/data            # slug→fund generator, slug list, SIP math
  instrumentation/ @mock/instrumentation # core + React wrappers (NR or console sink)
  ui/              @mock/ui              # FundHeader, NavChart, SipCalculator, RiskGauge … + PageShell
```

## Run

```bash
cd mock-app
npm install
npm run dev          # http://localhost:3000/investments/nippon-india-taiwan-equity-fund-g-growth?next=true
```

Try any slug ending in `-growth`, e.g.
`/investments/parag-parikh-flexi-cap-fund-direct-growth` — every URL renders.

Other commands: `npm run build`, `npm run typecheck`.

## The full pipeline (actually implemented, runnable)

This mock implements the whole monitoring process end-to-end — not just the page:

```
 Browser (instrumentation) ─┐
                            ├─► /api/telemetry ─► .data/events.ndjson  (NRDB stand-in)
 scripts/crawl.mjs  ────────┘                          │
                                                        ▼
                                            scripts/report.mjs ─► out/daily-report.html + out/fleet.csv
```

1. **Collector** — `app/api/telemetry/route.ts` + `@mock/telemetry` store. The page
   instrumentation streams events here via `navigator.sendBeacon`.
2. **Crawler** — `scripts/crawl.mjs` asks the slug API for all pages, visits each
   (timing load, checking component presence, timing the calc API) and pushes
   `Crawl*` events to the collector. This is the "active monitoring" half.
3. **Report** — `scripts/report.mjs` reads every event, aggregates it (the way the
   real Lambda does with NRQL), and writes an HTML email (with inline SVG charts)
   plus a per-page CSV to `./out`.

```bash
# with `npm run dev` (or `npm start`) running, and after browsing a page or two:
npm run crawl      # crawl all slugs → telemetry
npm run report     # build out/daily-report.html + out/fleet.csv
open out/daily-report.html
```

Crawl gives **coverage of every page** (load, component presence, API timing); RUM
(from browsing) gives **real client timings** (component render ms, CTA redirect ms).
The report merges both — exactly the crawl + RUM split from the architecture docs.

## What to observe (the point of the mock)

Open **DevTools → Console**. On load you'll see `[NR] ComponentRender {...}` for each
component with its `renderMs`; drag the SIP sliders to see `[NR] ApiCall {...}` with the
calc-API `durationMs`; click **OPEN MF ACCOUNT** to see `[NR] CtaClick` then `[NR] CtaRedirect`
with `redirectMs` on the next page. These are the exact events the real New Relic
agent would send and that the daily report aggregates across all 6,000 pages.

Instrumented components carry `data-nr-component="…"` + `elementtiming="…"`, and the CTA
carries `data-nr-cta="open-mf-account"` — the same hooks the Playwright crawler
(`reference/crawler/playwright-crawl-worker.ts`) selects on.

## Mapping to the architecture

| Mock piece | Real-world counterpart |
|---|---|
| `@mock/data` `getFundBySlug` + `KNOWN_SLUGS` | The fund + slug-list APIs |
| console / `window.__NR_EVENTS__` sink | New Relic Browser agent → NRDB |
| `data-nr-component` / `data-nr-cta` hooks | Same hooks the crawler & RUM read |
| `/api/funds/sip-calculate` round-trip | An `AjaxRequest` New Relic auto-captures |
| `reference/crawler/playwright-crawl-worker.ts` | Nightly crawl of all pages |
| `reference/lambda/*.lambda.ts` | Daily email report |
