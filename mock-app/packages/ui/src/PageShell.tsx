import React from 'react'
import type { Fund } from '@mock/data'
import { InstrumentedComponent, NrDimensions } from '@mock/instrumentation'
import { TopNav } from './TopNav'
import { FundHeader } from './FundHeader'
import { ReturnsSummary } from './ReturnsSummary'
import { NavChart } from './NavChart'
import { OpenMfAccountCta } from './OpenMfAccountCta'
import { AboutFund } from './AboutFund'
import { FundDetailsTable } from './FundDetailsTable'
import { SipCalculator } from './SipCalculator'
import { RiskGauge } from './RiskGauge'

/**
 * Full fund-detail page composition. Each major component is wrapped in
 * <InstrumentedComponent> (mount timing + error boundary) and also carries a
 * data-nr-component / elementtiming attribute (for the crawler + Element Timing).
 * The app's page.tsx only renders <PageShell/> — all UI lives here in packages.
 */
export function PageShell({ fund, slug }: { fund: Fund; slug: string }) {
  return (
    <>
      <NrDimensions pageType="mf-detail" fundSlug={slug} fundCategory={fund.category} env="mock" appVersion="mock-0.0.0" />
      <TopNav />
      <main style={{ maxWidth: 1280, margin: 'auto', padding: '20px 16px', display: 'grid', gridTemplateColumns: '420px 1fr', gap: 24, alignItems: 'start' }}>
        {/* Left column */}
        <section style={{ border: '1px solid #eee', borderRadius: 12, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,.05)' }}>
          <InstrumentedComponent name="fund-header"><FundHeader fund={fund} /></InstrumentedComponent>
          <InstrumentedComponent name="returns-summary"><ReturnsSummary fund={fund} /></InstrumentedComponent>
          <InstrumentedComponent name="nav-chart"><NavChart fund={fund} /></InstrumentedComponent>
          <OpenMfAccountCta slug={slug} />
        </section>

        {/* Right column */}
        <section style={{ display: 'flex', flexDirection: 'column' }}>
          <AboutFund fund={fund} />
          <InstrumentedComponent name="fund-details-table"><FundDetailsTable fund={fund} /></InstrumentedComponent>
          <InstrumentedComponent name="sip-calculator"><SipCalculator /></InstrumentedComponent>
          <InstrumentedComponent name="risk-gauge"><RiskGauge fund={fund} /></InstrumentedComponent>
        </section>
      </main>
    </>
  )
}
