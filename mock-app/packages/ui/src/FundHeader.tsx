import React from 'react'
import type { Fund } from '@mock/data'

/**
 * Fund name + category (top-left of the page).
 * `data-nr-component` + `elementtiming` make this block measurable by both the
 * crawler and the browser's Element Timing API.
 */
export function FundHeader({ fund }: { fund: Fund }) {
  const initial = fund.name.slice(0, 1)
  return (
    <div data-nr-component="fund-header" {...{ elementtiming: 'fund-header' }} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <div style={{ width: 40, height: 40, borderRadius: 8, background: '#e8f0fe', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#1a73e8' }}>
        {initial}
      </div>
      <div>
        <h1 style={{ margin: 0, fontSize: 20, color: '#111' }}>{fund.name}</h1>
        <div style={{ fontSize: 12, color: '#777' }}>{fund.category}</div>
      </div>
    </div>
  )
}
