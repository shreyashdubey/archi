import { NextResponse } from 'next/server'
import { fetchSitemapSlugs } from '@mock/data'

// Hits the network (the sitemap) and must never be statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The sitemap is ~1 MB / ~6,000 URLs, so we cache it in the server process and
// reuse it across crawl-worker requests instead of re-downloading every call.
// TTL keeps it fresh across the day; `?refresh=1` forces a re-fetch.
const parsedTtl = Number(process.env.SLUGS_CACHE_TTL_MS)
const CACHE_TTL_MS = Number.isFinite(parsedTtl) && parsedTtl >= 0 ? parsedTtl : 10 * 60 * 1000
// A fallback result (sitemap unreachable → KNOWN_SLUGS) is cached only briefly, so
// one transient blip can't pin the 15-slug fallback for the whole TTL.
const FALLBACK_TTL_MS = Math.min(CACHE_TTL_MS, 30 * 1000)
let cachedSlugs: { slugs: string[]; source: string; fetchedAt: number } | null = null

/**
 * Mock "slug API" — the crawler/synthetics call this to enumerate pages. It now
 * serves slugs discovered from the live sitemap (with an in-memory cache and a
 * KNOWN_SLUGS fallback), so there's no hardcoded list to maintain.
 */
export async function GET(request: Request) {
  const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1'
  const ttl = cachedSlugs?.source === 'sitemap' ? CACHE_TTL_MS : FALLBACK_TTL_MS
  const isCacheFresh = cachedSlugs && Date.now() - cachedSlugs.fetchedAt < ttl

  if (forceRefresh || !isCacheFresh) {
    const { slugs, source } = await fetchSitemapSlugs()
    cachedSlugs = { slugs, source, fetchedAt: Date.now() }
  }

  const { slugs, source } = cachedSlugs!
  return NextResponse.json({ slugs, total: slugs.length, source })
}
