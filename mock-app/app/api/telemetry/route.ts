import { NextResponse } from 'next/server'
import { appendEvents, readEvents } from '@mock/telemetry'

// This route touches the filesystem, so it must run on the Node runtime and
// never be statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Telemetry collector — our stand-in for the New Relic ingest endpoint.
 * The browser instrumentation POSTs events here (via navigator.sendBeacon).
 */
export async function POST(request: Request) {
  const events = await request.json().catch(() => [])
  await appendEvents(events)
  return NextResponse.json({ ok: true, received: Array.isArray(events) ? events.length : 0 })
}

/** Quick health/debug check: how many events have been collected so far. */
export async function GET() {
  const events = await readEvents()
  return NextResponse.json({ count: events.length })
}
