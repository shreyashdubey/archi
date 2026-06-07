import React from 'react'
import { getFundBySlug } from '@mock/data'
import { PageShell } from '@mock/ui'

/**
 * Dynamic fund page. URL: /investments/{slug}-growth
 * (e.g. /investments/nippon-india-taiwan-equity-fund-g-growth?next=true)
 *
 * This file only resolves data + renders <PageShell/>. All UI/components live
 * in packages/ui; all instrumentation in packages/instrumentation.
 */
export default function Page({ params }: { params: { slug: string } }) {
  const fund = getFundBySlug(params.slug)
  return <PageShell fund={fund} slug={params.slug} />
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  return { title: `${getFundBySlug(params.slug).name} — Mock` }
}
