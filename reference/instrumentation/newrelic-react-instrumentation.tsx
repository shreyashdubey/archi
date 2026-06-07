/* =============================================================================
 * newrelic-react-instrumentation.tsx — Next.js/React variant of the component
 * instrumentation. Emits the SAME event schema as newrelic-browser-bootstrap.js
 * (ComponentRender / CtaRedirect) so NRQL + the report Lambda are unchanged.
 *
 * The live mock app ships a fuller version of this in
 * packages/instrumentation (it also logs to the console when no NR agent is
 * present, so you can watch the telemetry locally).
 * ========================================================================== */
'use client'
import React from 'react'

type NR = {
  addPageAction: (name: string, attrs: Record<string, unknown>) => void
  setCustomAttribute: (k: string, v: unknown) => void
  interaction?: () => { setName: (n: string) => { save: () => void } }
}
const nr = (): NR | undefined => (typeof window !== 'undefined' ? (window as any).newrelic : undefined)
const now = () => (typeof performance !== 'undefined' ? performance.now() : 0)

/** Set global dimensions once near the top of the tree (re-tag on route change). */
export function useNrDimensions(d: Record<string, string>) {
  React.useEffect(() => {
    const n = nr(); if (!n) return
    Object.entries(d).forEach(([k, v]) => n.setCustomAttribute(k, v))
  }, [d.fundSlug]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Report render success + latency; catch render errors via the boundary. */
export class InstrumentedComponent extends React.Component<
  { name: string; children: React.ReactNode },
  { failed: boolean }
> {
  start = now()
  state = { failed: false }
  componentDidMount() {
    nr()?.addPageAction('ComponentRender', { component: this.props.name, status: 'rendered', renderMs: Math.round(now() - this.start), errorMessage: null })
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) {
    nr()?.addPageAction('ComponentRender', { component: this.props.name, status: 'error', renderMs: null, errorMessage: error.message })
  }
  render() {
    return this.state.failed ? <div data-nr-failed={this.props.name} /> : this.props.children
  }
}

/** Data-driven components: call markReady() the moment data is applied to the DOM. */
export function useComponentTiming(name: string) {
  const start = React.useRef(now())
  return React.useCallback((status: 'rendered' | 'error' = 'rendered', error?: string) => {
    nr()?.addPageAction('ComponentRender', { component: name, status, renderMs: status === 'rendered' ? Math.round(now() - start.current) : null, errorMessage: error ?? null })
  }, [name])
}

/** CTA anchor that stamps the click for cross-page redirect timing. */
export function InstrumentedCta(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { cta: string }) {
  const { cta, onClick, ...rest } = props
  return (
    <a
      {...rest}
      data-nr-cta={cta}
      onClick={(e) => {
        const n = nr()
        try { sessionStorage.setItem('nr_cta', JSON.stringify({ cta, t: Date.now(), from: location.pathname })) } catch {}
        n?.addPageAction('CtaClick', { cta, fromPath: location.pathname })
        n?.interaction?.().setName(`cta:${cta}`).save()
        onClick?.(e)
      }}
    />
  )
}
