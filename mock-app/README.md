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
  api/funds/slugs/route.ts           # slug API — discovers pages from the live sitemap
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
 sitemap (~6,000 URLs) ─► /api/funds/slugs ─► sample 25 random
                                                        │
 Browser (instrumentation) ─┐                           ▼
                            ├─► /api/telemetry ─► .data/events.ndjson  (NRDB stand-in)
 scripts/crawl.mjs  ────────┘                          │
                                                        ▼
                                            scripts/report.mjs ─► preview/daily-report.html + preview/fleet.csv
```

1. **Discovery** — `app/api/funds/slugs/route.ts` fetches the live **sitemap**
   (`SITEMAP_URL`, ~6,000 fund URLs), extracts the slug from each, caches it, and
   serves the list (falling back to `KNOWN_SLUGS` offline). No hardcoded slugs.
2. **Collector** — `app/api/telemetry/route.ts` + `@mock/telemetry` store. The page
   instrumentation streams events here via `navigator.sendBeacon`.
3. **Crawler** — `scripts/crawl.mjs` asks the slug API for the pages, samples
   `SAMPLE_SIZE` random ones (default 25; `0` = all, like prod), visits each
   (timing load, checking component presence, timing the calc API) and pushes
   `Crawl*` events to the collector. This is the "active monitoring" half.
4. **Report** — `scripts/report.mjs` reads every event, aggregates it (the way the
   real Lambda does with NRQL), and writes an HTML email (with inline SVG charts)
   plus a per-page CSV to `./preview` (override with `REPORT_OUT_DIR`).

```bash
# with `npm run dev` (or `npm start`) running:
npm run generate-report  # discover → sample 25 random → crawl → build & open the report
```

`generate-report` is the one-command local run (the stand-in for the prod nightly
Lambda that crawls all ~6,000). It clears the store, crawls a fresh random sample,
then opens `preview/daily-report.html`. Tune it with env vars:

```bash
SAMPLE_SIZE=50 npm run generate-report     # monitor 50 random pages this run
CRAWLER=browser npm run generate-report    # real-browser render times (slower)
SAMPLE_SIZE=0 npm run generate-report      # the whole fleet, like prod
```

> **Port note:** if `3000` is busy, `next dev` quietly starts on `3001`/`3002`/…. The
> crawler auto-detects the mock across ports `3000–3003`, so this usually just works.
> To be explicit, pin one: `PORT=3001 npm run dev` and `PORT=3001 npm run generate-report`
> (or set `BASE_URL=http://localhost:3001`).

The underlying steps are still available on their own (after browsing a page or two
for RUM data): `npm run crawl` (fetch-crawl a sample), `npm run crawl:browser`
(real-browser render times), `npm run report` (re-render from the stored events).

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
| `@mock/data` `getFundBySlug` + sitemap discovery (`KNOWN_SLUGS` fallback) | The fund API + the site's sitemap |
| console / `window.__NR_EVENTS__` sink | New Relic Browser agent → NRDB |
| `data-nr-component` / `data-nr-cta` hooks | Same hooks the crawler & RUM read |
| `/api/funds/sip-calculate` round-trip | An `AjaxRequest` New Relic auto-captures |
| `reference/crawler/playwright-crawl-worker.ts` | Nightly crawl of all pages |
| `reference/lambda/*.lambda.ts` | Daily email report |
