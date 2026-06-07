/* =============================================================================
 * newrelic-browser-bootstrap.js — framework-agnostic New Relic instrumentation
 * for the fund page template. Works for AEM HTL-rendered DOM OR React/Next.
 * Load AFTER the New Relic Browser agent loader. One <script> in the template
 * covers all 6,000+ pages.
 *
 * Emits: global dimensions + ComponentRender (rendered/error/missing) + CtaRedirect.
 * API timing (AjaxRequest) is auto-captured by the agent.
 *
 * Markup hooks the template adds once:
 *   <body data-page-type="mf-detail" data-fund-slug="…" data-fund-category="…"
 *         data-nr-expected="fund-header,nav-chart,sip-calculator,risk-gauge">
 *   <section data-nr-component="sip-calculator" elementtiming="sip-calculator">…</section>
 *   <a data-nr-cta="open-mf-account" href="…">OPEN MF ACCOUNT</a>
 * ========================================================================== */
(function () {
  'use strict';
  var nr = window.newrelic;
  if (!nr) { console.warn('[nr-bootstrap] agent not present'); return; }

  var body = document.body;
  var attr = function (k, d) { return body.getAttribute(k) || d; };
  var slugFromPath = function () {
    var p = location.pathname.split('/').filter(Boolean);
    return p[p.length - 1] || 'unknown';
  };

  // ---- 1. Global dimensions (attached to every event) -----------------------
  var dims = {
    pageType: attr('data-page-type', 'mf-detail'),
    fundSlug: attr('data-fund-slug', slugFromPath()),
    fundCategory: attr('data-fund-category', 'unknown'),
    appVersion: window.__APP_VERSION__ || 'unknown',
    env: window.__ENV__ || 'prod',
  };
  Object.keys(dims).forEach(function (k) { nr.setCustomAttribute(k, dims[k]); });
  if (nr.setPageViewName) nr.setPageViewName(dims.pageType);

  // ---- 2. Component render: success + latency (single reporter, dedup) -------
  var seen = Object.create(null);
  function report(component, status, renderMs, errorMessage) {
    if (seen[component] === 'rendered') return; // first success wins
    seen[component] = status;
    nr.addPageAction('ComponentRender', {
      component: component, status: status,
      renderMs: renderMs != null ? Math.round(renderMs) : null,
      errorMessage: errorMessage || null,
    });
  }

  // 2a. Markup components via Element Timing API.
  if ('PerformanceObserver' in window) {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.identifier) report(e.identifier, 'rendered', e.renderTime || e.loadTime);
        });
      }).observe({ type: 'element', buffered: true });
    } catch (_) {}
  }

  // 2b. Manual hook for data-driven components (chart/calculator): call when the
  //     component has data applied to the DOM (true time-to-usable).
  window.nrComponent = function (component, opts) {
    opts = opts || {};
    var ms = opts.renderMs;
    if (ms == null && opts.startMark != null) ms = performance.now() - opts.startMark;
    report(component, opts.status || 'rendered', ms, opts.error);
  };

  // 2c. Uncaught errors → mark nearest tagged component as errored.
  window.addEventListener('error', function (ev) {
    var el = ev.target && ev.target.closest && ev.target.closest('[data-nr-component]');
    if (el) report(el.getAttribute('data-nr-component'), 'error', null, String(ev.message || 'error'));
  }, true);

  // ---- 3. CTA → redirect timing (epoch-bridged across the navigation) -------
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('[data-nr-cta]');
    if (!a) return;
    var cta = a.getAttribute('data-nr-cta');
    try { sessionStorage.setItem('nr_cta', JSON.stringify({ cta: cta, t: Date.now(), from: location.pathname })); } catch (_) {}
    nr.addPageAction('CtaClick', { cta: cta, fromPath: location.pathname });
    if (nr.interaction) { try { nr.interaction().setName('cta:' + cta).save(); } catch (_) {} }
  }, true);

  // ---- 4. On load: missing-component check + destination-side CtaRedirect ----
  window.addEventListener('load', function () {
    // 4a. CtaRedirect (computed on the page we landed on).
    var raw; try { raw = sessionStorage.getItem('nr_cta'); } catch (_) { raw = null; }
    if (raw) {
      try { sessionStorage.removeItem('nr_cta'); } catch (_) {}
      var c; try { c = JSON.parse(raw); } catch (_) { c = null; }
      var age = c && c.t ? Date.now() - c.t : Infinity;
      if (c && age >= 0 && age <= 60000) {
        var nav = performance.getEntriesByType('navigation')[0];
        var redirectMs = Math.round(performance.timeOrigin + (nav ? nav.domContentLoadedEventEnd : 0) - c.t);
        if (redirectMs > 0) nr.addPageAction('CtaRedirect', { cta: c.cta, redirectMs: redirectMs, fromPath: c.from, toPath: location.pathname });
      }
    }
    // 4b. After a grace window, any expected component with no event = missing.
    var expected = attr('data-nr-expected', '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    setTimeout(function () {
      expected.forEach(function (name) { if (!seen[name]) report(name, 'missing', null, 'no render event'); });
    }, 4000);
  });
})();
