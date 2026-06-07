import React from 'react'
import type { Fund } from '@mock/data'

/** One-line "returns over the last year" summary. */
export function ReturnsSummary({ fund }: { fund: Fund }) {
  return (
    <div data-nr-component="returns-summary" {...{ elementtiming: 'returns-summary' }} style={{ marginTop: 12, fontSize: 13, color: '#333' }}>
      Returns <strong style={{ color: '#0b8a3e' }}>{fund.oneYearReturnPct}%</strong> annually for last 1 yr
    </div>
  )
}
