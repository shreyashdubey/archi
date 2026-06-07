/* =============================================================================
 * New Relic Synthetics — Scripted API monitor (type: SCRIPT_API).
 *
 * JOB: cover the long tail of /investments/{slug}-growth pages WITHOUT one
 * monitor per page. Each run pulls the live sitemap, extracts the slugs, then
 * checks a ROTATING SAMPLE (always-critical funds + a rotating window),
 * asserting reachability and that the key components are present in the HTML.
 *
 * Name the monitor `investments-growth-rotating` (or any `investments-growth-rotating*`)
 * so the fleet digest's NRQL — monitorName LIKE 'investments-growth-rotating%' — finds it.
 * The `rotating` token keeps it distinct from the single-page SIMPLE monitor
 * (`investments-growth-page-monitor`), so that one isn't counted in fleet coverage.
 *
 * Schedule: EVERY_5_MINUTES from 3 locations → sweeps thousands of pages/day.
 * ========================================================================== */
var assert = require('assert')

// Env: SITEMAP_URL, INVESTMENTS_BASE_URL (defaults below if unset).
var SITEMAP_URL = process.env.SITEMAP_URL || 'https://www.bajajfinserv.in/api/amc-pdp/sitemap-details' // returns [{ url, ... }]
var INVESTMENTS_BASE_URL = process.env.INVESTMENTS_BASE_URL || 'https://www.bajajfinserv.in/investments/'
var ALWAYS_CHECK_SLUGS = ['nippon-india-taiwan-equity-fund-g-growth'] // critical funds
var ROTATING_SAMPLE_SIZE = 8 // additional pages per run
var RUN_INTERVAL_MINUTES = Number(process.env.RUN_INTERVAL_MINUTES || 5) // MUST match the monitor schedule
var MONITORED_SUFFIX = '-growth' // monitored template: /investments/*-growth only
var REQUEST_TIMEOUT_MS = 25000

/** Pull the fund slug out of an `/investments/{slug}` URL; null if it isn't one. */
function slugFromUrl(url) {
  var marker = '/investments/'
  var markerIndex = url.indexOf(marker)
  if (markerIndex === -1) return null
  var rest = url.slice(markerIndex + marker.length).split('?')[0].split('#')[0]
  if (rest.charAt(rest.length - 1) === '/') rest = rest.slice(0, -1)
  return rest || null
}

/**
 * Pick a window of `size` slugs that advances by exactly `size` every RUN (keyed
 * on a monotonic run ordinal, not wall-clock minutes), so consecutive runs cover
 * different, NON-OVERLAPPING pages and the windows march across the whole fleet —
 * full coverage in ~ceil(N / (runsPerDay * size)) days. Deterministic (no blocked
 * PRNG): the ordinal comes from the clock + cadence.
 */
function rotatingWindow(allSlugs, windowSize, runOrdinal) {
  if (allSlugs.length <= windowSize) return allSlugs
  var startIndex = (runOrdinal * windowSize) % allSlugs.length
  var windowSlugs = []
  for (var offset = 0; offset < windowSize; offset++) {
    windowSlugs.push(allSlugs[(startIndex + offset) % allSlugs.length])
  }
  return windowSlugs
}

$http.get({ url: SITEMAP_URL, json: true, timeout: REQUEST_TIMEOUT_MS }, function (sitemapError, sitemapResponse, sitemapBody) {
  assert.ok(!sitemapError, 'sitemap error: ' + sitemapError)
  assert.equal(sitemapResponse.statusCode, 200, 'sitemap status ' + sitemapResponse.statusCode)

  // Parse the sitemap → slugs, keeping the absolute URL for each so we hit the
  // canonical page (and fall back to INVESTMENTS_BASE_URL + slug if needed).
  var entries = sitemapBody || []
  var allSlugs = []
  var urlBySlug = {}
  for (var entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    var entryUrl = entries[entryIndex] && entries[entryIndex].url
    var slug = entryUrl ? slugFromUrl(entryUrl) : null
    // Keep only the monitored /investments/*-growth template (slug.endsWith).
    var isGrowth = slug && slug.slice(-MONITORED_SUFFIX.length) === MONITORED_SUFFIX
    if (isGrowth && !urlBySlug[slug]) {
      urlBySlug[slug] = entryUrl
      allSlugs.push(slug)
    }
  }
  assert.ok(allSlugs.length > 0, 'sitemap returned no /investments/*-growth slugs')

  // Monotonic run ordinal: which scheduled run this is since the epoch. Keying the
  // window on this (not raw minuteOfDay) makes the stride equal the window size, so
  // runs don't overlap or leave gaps, and coverage keeps advancing day over day.
  var now = new Date() // allowed inside the Synthetics runtime
  var minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes()
  var runsPerDay = Math.floor(1440 / RUN_INTERVAL_MINUTES)
  var dayNumber = Math.floor(now.getTime() / 86400000)
  var runOrdinal = dayNumber * runsPerDay + Math.floor(minuteOfDay / RUN_INTERVAL_MINUTES)
  var slugsToCheck = ALWAYS_CHECK_SLUGS.concat(rotatingWindow(allSlugs, ROTATING_SAMPLE_SIZE, runOrdinal))

  console.log('Checking ' + slugsToCheck.length + ' of ' + allSlugs.length + ' slugs this run')

  // Check each sampled page in turn; record which slug each check covered.
  var nextSlugIndex = 0
  function checkNextSlug() {
    if (nextSlugIndex >= slugsToCheck.length) return
    var slug = slugsToCheck[nextSlugIndex++]
    var pageUrl = urlBySlug[slug] || INVESTMENTS_BASE_URL + slug
    $util.insights.set('checkedSlug', slug) // → custom.checkedSlug in NRDB

    $http.get({ url: pageUrl + '?next=true', timeout: REQUEST_TIMEOUT_MS }, function (pageError, pageResponse, pageHtml) {
      try {
        assert.ok(!pageError, 'request error for ' + slug + ': ' + pageError)
        assert.equal(pageResponse.statusCode, 200, slug + ' -> HTTP ' + pageResponse.statusCode)
        // Functional checks: key components must be present in the markup.
        assert.ok(/data-nr-component="sip-calculator"/.test(pageHtml), slug + ': calculator missing')
        assert.ok(/data-nr-cta="open-mf-account"/.test(pageHtml), slug + ': CTA missing')
      } catch (checkFailure) {
        console.error(String(checkFailure))
        throw checkFailure // marks this check FAILED in New Relic
      }
      checkNextSlug()
    })
  }
  checkNextSlug()
})
