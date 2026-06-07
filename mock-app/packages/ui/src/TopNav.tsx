import React from 'react'

/** Simplified Bajaj-Finserv-style top bar (not instrumented). */
export function TopNav() {
  const navLinkLabels = ['Loans', 'All on EMI', 'Bajaj Mall', 'Cards', 'Investments', 'Insurance', 'Payments', 'Offers', 'Services']
  return (
    <header style={{ background: '#02273f', color: '#fff' }}>
      <div style={{ maxWidth: 1280, margin: 'auto', display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px' }}>
        <div style={{ fontWeight: 800, fontSize: 15, background: '#0b6', borderRadius: 4, padding: '2px 8px' }}>B</div>
        <strong style={{ fontSize: 13 }}>BAJAJ FINSERV</strong>
        <input
          placeholder="Search Bajaj Finserv…"
          style={{ flex: 1, maxWidth: 420, padding: '8px 12px', borderRadius: 6, border: 'none', fontSize: 13 }}
        />
        <span style={{ fontSize: 12, opacity: 0.85 }}>Sign in</span>
      </div>
      <nav style={{ background: '#0a3a5c' }}>
        <div style={{ maxWidth: 1280, margin: 'auto', display: 'flex', gap: 18, padding: '8px 16px', fontSize: 12.5, flexWrap: 'wrap' }}>
          {navLinkLabels.map((linkLabel) => (
            <span key={linkLabel} style={{ opacity: 0.9 }}>{linkLabel} ▾</span>
          ))}
        </div>
      </nav>
    </header>
  )
}
