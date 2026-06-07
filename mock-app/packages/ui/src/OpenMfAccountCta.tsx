import React from 'react'

/**
 * Primary CTA. data-nr-cta="open-mf-account" — the global click handler stamps
 * the click and CtaRedirect is measured on the destination page.
 * href points to another in-app route so the redirect timing is observable.
 */
export function OpenMfAccountCta({ slug }: { slug: string }) {
  return (
    <a
      data-nr-cta="open-mf-account"
      href={`/investments/${slug}?next=true&open=1`}
      style={{
        display: 'block', textAlign: 'center', marginTop: 18, background: '#f47216', color: '#fff',
        padding: '14px 16px', borderRadius: 8, textDecoration: 'none', fontWeight: 700, fontSize: 14,
      }}
    >
      OPEN MF ACCOUNT →
    </a>
  )
}
