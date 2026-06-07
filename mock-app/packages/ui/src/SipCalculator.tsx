'use client'
import React from 'react'
import type { SipResult } from '@mock/data'
import { useComponentTiming } from '@mock/instrumentation'

/** Format a number as Indian rupees, e.g. 703386 → "₹7,03,386". */
const formatRupees = (amount: number) => '₹' + amount.toLocaleString('en-IN')

/**
 * "Calculate your return" SIP calculator. Every slider change calls the real
 * /api/funds/sip-calculate endpoint, so the instrumentation records an ApiCall
 * event with the true round-trip time.
 */
export function SipCalculator() {
  const [monthlyAmount, setMonthlyAmount] = React.useState(25000)
  const [years, setYears] = React.useState(2)
  const [expectedReturnPct, setExpectedReturnPct] = React.useState(15)
  const [result, setResult] = React.useState<SipResult | null>(null)

  const reportRenderTiming = useComponentTiming('sip-calculator')
  const isFirstResult = React.useRef(true)

  // Re-calculate (debounced) whenever an input changes.
  React.useEffect(() => {
    const debounceTimer = setTimeout(async () => {
      try {
        const response = await fetch('/api/funds/sip-calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ monthly: monthlyAmount, years, rate: expectedReturnPct }),
        })
        setResult(await response.json())
        // Report render timing once, after the first successful calculation.
        if (isFirstResult.current) {
          isFirstResult.current = false
          reportRenderTiming('rendered')
        }
      } catch (error) {
        reportRenderTiming('error', String(error))
      }
    }, 250) // wait for the slider drag to settle

    return () => clearTimeout(debounceTimer)
  }, [monthlyAmount, years, expectedReturnPct, reportRenderTiming])

  return (
    <section data-nr-component="sip-calculator" {...{ elementtiming: 'sip-calculator' }} style={{ marginTop: 22 }}>
      <h3 style={{ fontSize: 15, color: '#111' }}>Calculate your return</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        {/* Inputs */}
        <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 16 }}>
          <Slider label="Monthly Investment" value={monthlyAmount} min={100} max={1000000} step={100}
            valueLabel={formatRupees(monthlyAmount)} onValueChange={setMonthlyAmount} />
          <Slider label="Tenure (in years)" value={years} min={1} max={30} step={1}
            valueLabel={`${years} years`} onValueChange={setYears} />
          <Slider label="Expected Return" value={expectedReturnPct} min={1} max={30} step={1}
            valueLabel={`${expectedReturnPct}%`} onValueChange={setExpectedReturnPct} />
        </div>

        {/* Result */}
        <div style={{ background: '#5145d6', color: '#fff', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>Total value</div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{result ? formatRupees(result.totalValue) : '…'}</div>
          <div style={{ display: 'flex', gap: 18, marginTop: 14, fontSize: 12 }}>
            <div>
              <div style={{ opacity: 0.8 }}>Estimated returns</div>
              <strong>{result ? formatRupees(result.estimatedReturns) : '…'}</strong>
            </div>
            <div>
              <div style={{ opacity: 0.8 }}>Invested Amount</div>
              <strong>{result ? formatRupees(result.totalInvested) : '…'}</strong>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** A single labelled range slider. */
function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  valueLabel: string
  onValueChange: (next: number) => void
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        <span style={{ color: '#444' }}>{props.label}</span>
        <span style={{ fontWeight: 700, color: '#111', background: '#f3f3f8', borderRadius: 6, padding: '2px 10px' }}>{props.valueLabel}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onValueChange(Number(event.target.value))}
        style={{ width: '100%', accentColor: '#5145d6' }}
      />
    </div>
  )
}
