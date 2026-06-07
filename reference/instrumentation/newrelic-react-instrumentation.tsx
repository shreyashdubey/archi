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
const getNewrelicAgent = (): NR | undefined => (typeof window !== 'undefined' ? (window as any).newrelic : undefined)
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0)

/** Set global dimensions once near the top of the tree (re-tag on route change). */
export function useNrDimensions(dimensions: Record<string, string>) {
  React.useEffect(() => {
    const agent = getNewrelicAgent(); if (!agent) return
    Object.entries(dimensions).forEach(([dimensionName, dimensionValue]) => agent.setCustomAttribute(dimensionName, dimensionValue))
  }, [dimensions.fundSlug]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Report render success + latency; catch render errors via the boundary. */
export class InstrumentedComponent extends React.Component<
  { name: string; children: React.ReactNode },
  { failed: boolean }
> {
  renderStartMs = nowMs()
  state = { failed: false }
  componentDidMount() {
    getNewrelicAgent()?.addPageAction('ComponentRender', { component: this.props.name, status: 'rendered', renderMs: Math.round(nowMs() - this.renderStartMs), errorMessage: null })
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) {
    getNewrelicAgent()?.addPageAction('ComponentRender', { component: this.props.name, status: 'error', renderMs: null, errorMessage: error.message })
  }
  render() {
    return this.state.failed ? <div data-nr-failed={this.props.name} /> : this.props.children
  }
}

/** Data-driven components: call markReady() the moment data is applied to the DOM. */
export function useComponentTiming(name: string) {
  const renderStartMs = React.useRef(nowMs())
  return React.useCallback((status: 'rendered' | 'error' = 'rendered', error?: string) => {
    getNewrelicAgent()?.addPageAction('ComponentRender', { component: name, status, renderMs: status === 'rendered' ? Math.round(nowMs() - renderStartMs.current) : null, errorMessage: error ?? null })
  }, [name])
}

/** CTA anchor that stamps the click for cross-page redirect timing. */
export function InstrumentedCta(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { cta: string }) {
  const { cta, onClick, ...anchorProps } = props
  return (
    <a
      {...anchorProps}
      data-nr-cta={cta}
      onClick={(clickEvent) => {
        const agent = getNewrelicAgent()
        try { sessionStorage.setItem('nr_cta', JSON.stringify({ cta, t: Date.now(), from: location.pathname })) } catch {}
        agent?.addPageAction('CtaClick', { cta, fromPath: location.pathname })
        agent?.interaction?.().setName(`cta:${cta}`).save()
        onClick?.(clickEvent)
      }}
    />
  )
}
