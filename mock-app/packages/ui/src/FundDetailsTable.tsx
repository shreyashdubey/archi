import React from 'react'
import type { Fund } from '@mock/data'

/** Key fund facts as a label/value table. */
export function FundDetailsTable({ fund }: { fund: Fund }) {
  // Pairs of [label, value] rendered as table rows.
  const detailRows: [string, string][] = [
    ['Fund age', fund.fundAge],
    ['AUM', `₹ ${fund.aumInCrores.toLocaleString('en-IN')} Cr`],
    ['Lock-in Period', fund.lockInPeriod],
    ['Exit Load', fund.exitLoad],
    ['Expense ratio', `${fund.expenseRatioPct}%`],
  ]

  return (
    <section data-nr-component="fund-details-table" {...{ elementtiming: 'fund-details-table' }} style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 14, color: '#111' }}>About Fund</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {detailRows.map(([label, value]) => (
            <tr key={label}>
              <td style={{ padding: '10px 12px', border: '1px solid #eee', color: '#666', width: 160, verticalAlign: 'top' }}>{label}</td>
              <td style={{ padding: '10px 12px', border: '1px solid #eee', color: '#222' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
