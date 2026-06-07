'use client'
import React from 'react'
import type { Fund } from '@mock/data'
import { useComponentTiming } from '@mock/instrumentation'

/** How many NAV-history points each timeframe tab shows. */
const TIMEFRAME_TO_POINTS: Record<string, number> = {
  '5D': 5, '1M': 8, '3M': 14, '6M': 22, '1Y': 30, '3Y': 36, '5Y': 40,
}

const CHART_WIDTH = 560
const CHART_HEIGHT = 220
const CHART_PADDING = 10

/**
 * NAV area chart with timeframe tabs. This is a "data-driven" component, so it
 * reports its render timing via `useComponentTiming` once the chart is on screen.
 */
export function NavChart({ fund }: { fund: Fund }) {
  const [activeTimeframe, setActiveTimeframe] = React.useState<keyof typeof TIMEFRAME_TO_POINTS>('1Y')
  const reportRenderTiming = useComponentTiming('nav-chart')

  // Report "time to usable" after the chart has mounted with data.
  React.useEffect(() => {
    reportRenderTiming('rendered')
  }, [reportRenderTiming])

  // Slice the most recent N points for the selected timeframe.
  const visiblePrices = fund.navHistory.slice(-TIMEFRAME_TO_POINTS[activeTimeframe])
  const lowestPrice = Math.min(...visiblePrices)
  const highestPrice = Math.max(...visiblePrices)

  // Map a data point (index, price) to SVG coordinates.
  const toX = (index: number) =>
    CHART_PADDING + (index / (visiblePrices.length - 1)) * (CHART_WIDTH - CHART_PADDING * 2)
  const toY = (price: number) =>
    CHART_HEIGHT - CHART_PADDING - ((price - lowestPrice) / (highestPrice - lowestPrice || 1)) * (CHART_HEIGHT - CHART_PADDING * 2)

  const linePath = visiblePrices.map((price, index) => `${index === 0 ? 'M' : 'L'}${toX(index).toFixed(1)},${toY(price).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${toX(visiblePrices.length - 1).toFixed(1)},${CHART_HEIGHT - CHART_PADDING} L${toX(0).toFixed(1)},${CHART_HEIGHT - CHART_PADDING} Z`

  return (
    <div data-nr-component="nav-chart" {...{ elementtiming: 'nav-chart' }} style={{ marginTop: 16 }}>
      <svg width="100%" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="navAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7bc99a" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#7bc99a" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#navAreaFill)" />
        <path d={linePath} fill="none" stroke="#2e9e5b" strokeWidth={2} />
      </svg>

      {/* Timeframe tabs */}
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#666', marginTop: 6 }}>
        {Object.keys(TIMEFRAME_TO_POINTS).map((timeframe) => {
          const isActive = activeTimeframe === timeframe
          return (
            <button
              key={timeframe}
              onClick={() => setActiveTimeframe(timeframe as keyof typeof TIMEFRAME_TO_POINTS)}
              style={{
                border: 'none', background: 'none', cursor: 'pointer', padding: '2px 4px',
                fontWeight: isActive ? 700 : 400,
                color: isActive ? '#0b6' : '#666',
                borderBottom: isActive ? '2px solid #0b6' : '2px solid transparent',
              }}
            >
              {timeframe}
            </button>
          )
        })}
      </div>

      {/* NAV + minimum SIP */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 13 }}>
        <div>
          <div style={{ color: '#888', fontSize: 11 }}>NAV on {fund.navDate}</div>
          <strong>₹{fund.nav}</strong>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: '#888', fontSize: 11 }}>Min SIP Amount</div>
          <strong>₹{fund.minSipAmount}</strong>
        </div>
      </div>
    </div>
  )
}
