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
  const submittedEvents = await request.json().catch(() => [])
  await appendEvents(submittedEvents)

  const receivedCount = Array.isArray(submittedEvents) ? submittedEvents.length : 0
  return NextResponse.json({ ok: true, received: receivedCount })
}

/** Quick health/debug check: how many events have been collected so far. */
export async function GET() {
  const collectedEvents = await readEvents()
  return NextResponse.json({ count: collectedEvents.length })
}
