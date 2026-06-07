import React from 'react'
import { NewRelicBootstrap } from '@mock/instrumentation'

export const metadata = {
  title: 'Mutual Fund — Mock',
  description: 'Mock fund-detail template for monitoring instrumentation',
}

/** Root layout. Installs global instrumentation; renders nothing else itself. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body data-page-type="mf-detail" style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#fff', color: '#111' }}>
        {/* In production the New Relic Browser loader snippet would go in <head>. */}
        <NewRelicBootstrap />
        {children}
      </body>
    </html>
  )
}
