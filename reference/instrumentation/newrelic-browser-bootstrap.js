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
  var newrelicAgent = window.newrelic;
  if (!newrelicAgent) { console.warn('[nr-bootstrap] agent not present'); return; }

  var body = document.body;
  var bodyAttr = function (attributeName, defaultValue) { return body.getAttribute(attributeName) || defaultValue; };
  var slugFromPath = function () {
    var pathSegments = location.pathname.split('/').filter(Boolean);
    return pathSegments[pathSegments.length - 1] || 'unknown';
  };

  // ---- 1. Global dimensions (attached to every event) -----------------------
  var globalDimensions = {
    pageType: bodyAttr('data-page-type', 'mf-detail'),
    fundSlug: bodyAttr('data-fund-slug', slugFromPath()),
    fundCategory: bodyAttr('data-fund-category', 'unknown'),
    appVersion: window.__APP_VERSION__ || 'unknown',
    env: window.__ENV__ || 'prod',
  };
  Object.keys(globalDimensions).forEach(function (dimensionName) {
    newrelicAgent.setCustomAttribute(dimensionName, globalDimensions[dimensionName]);
  });
  if (newrelicAgent.setPageViewName) newrelicAgent.setPageViewName(globalDimensions.pageType);

  // ---- 2. Component render: success + latency (single reporter, dedup) -------
  var statusByComponent = Object.create(null);
  function report(component, status, renderMs, errorMessage) {
    if (statusByComponent[component] === 'rendered') return; // first success wins
    statusByComponent[component] = status;
    newrelicAgent.addPageAction('ComponentRender', {
      component: component, status: status,
      renderMs: renderMs != null ? Math.round(renderMs) : null,
      errorMessage: errorMessage || null,
    });
  }

  // 2a. Markup components via Element Timing API.
  if ('PerformanceObserver' in window) {
    try {
      new PerformanceObserver(function (entryList) {
        entryList.getEntries().forEach(function (elementTiming) {
          if (elementTiming.identifier) {
            report(elementTiming.identifier, 'rendered', elementTiming.renderTime || elementTiming.loadTime);
          }
        });
      }).observe({ type: 'element', buffered: true });
    } catch (observerError) {}
  }

  // 2b. Manual hook for data-driven components (chart/calculator): call when the
  //     component has data applied to the DOM (true time-to-usable).
  window.nrComponent = function (component, options) {
    options = options || {};
    var renderMs = options.renderMs;
    if (renderMs == null && options.startMark != null) renderMs = performance.now() - options.startMark;
    report(component, options.status || 'rendered', renderMs, options.error);
  };

  // 2c. Uncaught errors → mark nearest tagged component as errored.
  window.addEventListener('error', function (errorEvent) {
    var componentElement = errorEvent.target && errorEvent.target.closest && errorEvent.target.closest('[data-nr-component]');
    if (componentElement) {
      report(componentElement.getAttribute('data-nr-component'), 'error', null, String(errorEvent.message || 'error'));
    }
  }, true);

  // ---- 3. CTA → redirect timing (epoch-bridged across the navigation) -------
  document.addEventListener('click', function (clickEvent) {
    var ctaElement = clickEvent.target.closest && clickEvent.target.closest('[data-nr-cta]');
    if (!ctaElement) return;
    var cta = ctaElement.getAttribute('data-nr-cta');
    try { sessionStorage.setItem('nr_cta', JSON.stringify({ cta: cta, t: Date.now(), from: location.pathname })); } catch (storageError) {}
    newrelicAgent.addPageAction('CtaClick', { cta: cta, fromPath: location.pathname });
    if (newrelicAgent.interaction) { try { newrelicAgent.interaction().setName('cta:' + cta).save(); } catch (interactionError) {} }
  }, true);

  // ---- 4. On load: missing-component check + destination-side CtaRedirect ----
  window.addEventListener('load', function () {
    // 4a. CtaRedirect (computed on the page we landed on).
    var storedClick; try { storedClick = sessionStorage.getItem('nr_cta'); } catch (storageError) { storedClick = null; }
    if (storedClick) {
      try { sessionStorage.removeItem('nr_cta'); } catch (storageError) {}
      var clickRecord; try { clickRecord = JSON.parse(storedClick); } catch (parseError) { clickRecord = null; }
      var clickAgeMs = clickRecord && clickRecord.t ? Date.now() - clickRecord.t : Infinity;
      if (clickRecord && clickAgeMs >= 0 && clickAgeMs <= 60000) {
        var navigationTiming = performance.getEntriesByType('navigation')[0];
        var redirectMs = Math.round(performance.timeOrigin + (navigationTiming ? navigationTiming.domContentLoadedEventEnd : 0) - clickRecord.t);
        if (redirectMs > 0) {
          newrelicAgent.addPageAction('CtaRedirect', { cta: clickRecord.cta, redirectMs: redirectMs, fromPath: clickRecord.from, toPath: location.pathname });
        }
      }
    }
    // 4b. After a grace window, any expected component with no event = missing.
    var expectedComponents = bodyAttr('data-nr-expected', '').split(',').map(function (rawName) { return rawName.trim(); }).filter(Boolean);
    setTimeout(function () {
      expectedComponents.forEach(function (component) {
        if (!statusByComponent[component]) report(component, 'missing', null, 'no render event');
      });
    }, 4000);
  });
})();
