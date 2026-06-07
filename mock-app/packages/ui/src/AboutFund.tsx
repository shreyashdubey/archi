import React from 'react'
import type { Fund } from '@mock/data'

/** "About the fund" + "Key features" prose blocks. */
export function AboutFund({ fund }: { fund: Fund }) {
  const subCategory = fund.category.split('|').pop()?.trim()
  return (
    <section data-nr-component="about-fund" {...{ elementtiming: 'about-fund' }}>
      <h2 style={{ fontSize: 16, color: '#111' }}>About {fund.name}</h2>
      <p style={{ fontSize: 13, color: '#444', lineHeight: 1.6 }}>
        {fund.name} has an Asset Under Management (AUM) of ₹{fund.aumInCrores.toLocaleString('en-IN')} Cr as on 2026-06-05.
        The fund has an expense ratio of {fund.expenseRatioPct}%, which is quite reasonable compared to most other
        {' '}{fund.category} schemes.
      </p>
      <h3 style={{ fontSize: 14, color: '#111' }}>Key features of {fund.name}</h3>
      <p style={{ fontSize: 13, color: '#444', lineHeight: 1.6 }}>
        {fund.name} is a {fund.category} mutual fund scheme. The 1-year return of this fund was {fund.oneYearReturnPct}%.
        The sub-category is {subCategory}.
      </p>
    </section>
  )
}
