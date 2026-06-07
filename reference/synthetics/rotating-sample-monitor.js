/* =============================================================================
 * New Relic Synthetics — Scripted API monitor (type: SCRIPT_API).
 *
 * JOB: cover the long tail of /investments/{slug}-growth pages WITHOUT one
 * monitor per page. Each run pulls the slug list, then checks a ROTATING SAMPLE
 * (always-critical funds + a rotating window), asserting reachability and that
 * the key components are present in the HTML.
 *
 * Name the monitor `investments-growth-rotating` (or any `investments-growth-*`)
 * so the fleet digest's NRQL — monitorName LIKE 'investments-growth-%' — finds it.
 *
 * Schedule: EVERY_5_MINUTES from 3 locations → sweeps thousands of pages/day.
 * ========================================================================== */
var assert = require('assert')

var SLUG_API_URL = 'https://api.bajajfinserv.in/funds/slugs' // returns { slugs: [...] }
var INVESTMENTS_BASE_URL = 'https://app.bajajfinserv.in/investments/'
var ALWAYS_CHECK_SLUGS = ['nippon-india-taiwan-equity-fund-g-growth'] // critical funds
var ROTATING_SAMPLE_SIZE = 8 // additional pages per run
var REQUEST_TIMEOUT_MS = 25000

/**
 * Pick a window of `size` slugs that advances every minute, so consecutive runs
 * cover different pages. Deterministic (no Math.random, which Synthetics blocks).
 */
function rotatingWindow(allSlugs, size, minuteOfDay) {
  if (allSlugs.length <= size) return allSlugs
  var startIndex = (minuteOfDay * size) % allSlugs.length
  var window = []
  for (var i = 0; i < size; i++) window.push(allSlugs[(startIndex + i) % allSlugs.length])
  return window
}

$http.get({ url: SLUG_API_URL, json: true, timeout: REQUEST_TIMEOUT_MS }, function (err, response, body) {
  assert.ok(!err, 'slug API error: ' + err)
  assert.equal(response.statusCode, 200, 'slug API status ' + response.statusCode)

  var allSlugs = (body && body.slugs) || []
  assert.ok(allSlugs.length > 0, 'slug API returned no slugs')

  var now = new Date() // allowed inside the Synthetics runtime
  var minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes()
  var slugsToCheck = ALWAYS_CHECK_SLUGS.concat(rotatingWindow(allSlugs, ROTATING_SAMPLE_SIZE, minuteOfDay))

  console.log('Checking ' + slugsToCheck.length + ' of ' + allSlugs.length + ' slugs this run')

  // Check each sampled page in turn; record which slug each check covered.
  var index = 0
  function checkNextSlug() {
    if (index >= slugsToCheck.length) return
    var slug = slugsToCheck[index++]
    $util.insights.set('checkedSlug', slug) // → custom.checkedSlug in NRDB

    $http.get({ url: INVESTMENTS_BASE_URL + slug + '?next=true', timeout: REQUEST_TIMEOUT_MS }, function (pageErr, pageResponse, html) {
      try {
        assert.ok(!pageErr, 'request error for ' + slug + ': ' + pageErr)
        assert.equal(pageResponse.statusCode, 200, slug + ' -> HTTP ' + pageResponse.statusCode)
        // Functional checks: key components must be present in the markup.
        assert.ok(/data-nr-component="sip-calculator"/.test(html), slug + ': calculator missing')
        assert.ok(/data-nr-cta="open-mf-account"/.test(html), slug + ': CTA missing')
      } catch (failure) {
        console.error(String(failure))
        throw failure // marks this check FAILED in New Relic
      }
      checkNextSlug()
    })
  }
  checkNextSlug()
})
