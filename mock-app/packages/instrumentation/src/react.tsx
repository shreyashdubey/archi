'use client'
/**
 * Thin React wrappers over the core instrumentation. They emit the same event
 * schema (ComponentRender / CtaRedirect) so the crawler and report don't care
 * whether the data came from React or from plain markup.
 */
import React from 'react'
import { reportEvent, setDimensions, installGlobals, installFetchTiming, type Attrs } from './instrument'

/** A high-resolution timestamp in milliseconds (0 during SSR). */
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0)

/**
 * Mount this once in the root layout. It turns on the global listeners
 * (component render timing, fetch timing, CTA redirect timing).
 */
export function NewRelicBootstrap(): null {
  React.useEffect(() => {
    installFetchTiming()
    installGlobals()
    // A real setup would also inject the New Relic Browser loader snippet here.
    console.info('%c[NR] mock instrumentation active — watch this console for events', 'color:#0b6;font-weight:600')
  }, [])
  return null
}

/** Tag every event on this page with its dimensions (re-tags on slug change). */
export function NrDimensions(dimensions: Attrs & { fundSlug: string }): null {
  React.useEffect(() => {
    setDimensions(dimensions)
  }, [dimensions.fundSlug]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

/**
 * Wrap a component to report whether it rendered and how long it took. Acts as
 * an error boundary too: a crash is reported as a render failure instead of
 * taking down the page.
 */
export class InstrumentedComponent extends React.Component<
  { name: string; children: React.ReactNode },
  { hasRenderError: boolean }
> {
  private mountStartedAt = nowMs()
  state = { hasRenderError: false }

  componentDidMount() {
    reportEvent('ComponentRender', {
      component: this.props.name,
      status: 'rendered',
      renderMs: Math.round(nowMs() - this.mountStartedAt),
    })
  }

  static getDerivedStateFromError() {
    return { hasRenderError: true }
  }

  componentDidCatch(error: Error) {
    reportEvent('ComponentRender', {
      component: this.props.name,
      status: 'error',
      renderMs: null,
      errorMessage: error.message,
    })
  }

  render() {
    return this.state.hasRenderError ? <div data-nr-failed={this.props.name} /> : (this.props.children as React.ReactElement)
  }
}

/**
 * For data-driven components (chart, calculator): call the returned
 * `reportRenderTiming()` the moment real data is on screen, so the measured time
 * reflects "time to usable", not just "time to mount".
 */
export function useComponentTiming(componentName: string) {
  const renderStartedAt = React.useRef(nowMs())
  return React.useCallback(
    (status: 'rendered' | 'error' = 'rendered', errorMessage?: string) =>
      reportEvent('ComponentRender', {
        component: componentName,
        status,
        renderMs: status === 'rendered' ? Math.round(nowMs() - renderStartedAt.current) : null,
        errorMessage: errorMessage ?? null,
      }),
    [componentName],
  )
}
