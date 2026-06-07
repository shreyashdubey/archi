import { NextResponse } from 'next/server'
import { KNOWN_SLUGS } from '@mock/data'

/** Mock "slug API" — the crawler/synthetics would call this to enumerate pages. */
export function GET() {
  return NextResponse.json({ slugs: KNOWN_SLUGS, total: KNOWN_SLUGS.length })
}
