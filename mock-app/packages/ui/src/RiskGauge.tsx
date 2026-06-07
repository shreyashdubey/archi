import React from 'react'
import type { Fund } from '@mock/data'

/** Colour for each of the 6 risk segments, low → very high. */
const SEGMENT_COLORS = ['#2e9e5b', '#7bc99a', '#e7c200', '#f0a020', '#f06a20', '#d63031']
const SEGMENT_COUNT = SEGMENT_COLORS.length

const CENTER_X = 110
const CENTER_Y = 110
const RADIUS = 90

/** Risk & rating semicircular gauge with a needle at the fund's risk level. */
export function RiskGauge({ fund }: { fund: Fund }) {
  // "x,y" string for the point on the gauge arc at the given angle
  // (radians, measured from the +x axis).
  const arcPointAtAngle = (angleRadians: number) =>
    `${(CENTER_X + RADIUS * Math.cos(angleRadians)).toFixed(1)},${(CENTER_Y - RADIUS * Math.sin(angleRadians)).toFixed(1)}`

  // SVG path for one coloured segment of the 180° arc.
  const arcForSegment = (segmentIndex: number) => {
    const segmentStartAngle = Math.PI - (segmentIndex / SEGMENT_COUNT) * Math.PI
    const segmentEndAngle = Math.PI - ((segmentIndex + 1) / SEGMENT_COUNT) * Math.PI
    return `M ${arcPointAtAngle(segmentStartAngle)} A ${RADIUS} ${RADIUS} 0 0 1 ${arcPointAtAngle(segmentEndAngle)}`
  }

  // Needle points at the middle of the fund's risk-level segment.
  const needleAngle = Math.PI - ((fund.riskLevelIndex + 0.5) / SEGMENT_COUNT) * Math.PI
  const needleLength = RADIUS - 18
  const needleTipX = CENTER_X + needleLength * Math.cos(needleAngle)
  const needleTipY = CENTER_Y - needleLength * Math.sin(needleAngle)

  return (
    <section data-nr-component="risk-gauge" {...{ elementtiming: 'risk-gauge' }} style={{ marginTop: 22, textAlign: 'center' }}>
      <h3 style={{ fontSize: 15, color: '#111', textAlign: 'left' }}>Risk &amp; Rating</h3>
      <svg width="220" height="140" viewBox="0 0 220 140">
        {SEGMENT_COLORS.map((color, segmentIndex) => (
          <path key={segmentIndex} d={arcForSegment(segmentIndex)} stroke={color} strokeWidth={16} fill="none" />
        ))}
        <line x1={CENTER_X} y1={CENTER_Y} x2={needleTipX} y2={needleTipY} stroke="#111" strokeWidth={3} />
        <circle cx={CENTER_X} cy={CENTER_Y} r={5} fill="#111" />
      </svg>
      <div style={{ fontWeight: 700, color: '#d63031', fontSize: 14 }}>{fund.riskLabel}</div>
      <div style={{ fontSize: 12, color: '#777' }}>Your investment will be at <strong>{fund.riskLabel}</strong> risk</div>
    </section>
  )
}
