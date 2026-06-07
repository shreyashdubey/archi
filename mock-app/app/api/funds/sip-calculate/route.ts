import { NextResponse } from 'next/server'
import { sipCalculate } from '@mock/data'

/**
 * Mock SIP calculation API. The calculator fetches this on every change, so the
 * instrumentation records an ApiCall event with the real round-trip duration.
 * A small artificial delay makes the API timing visible in the telemetry.
 */
export async function POST(request: Request) {
  const { monthly = 25000, years = 2, rate = 15 } = await request.json().catch(() => ({}))

  const artificialDelayMs = 120 + Math.round(Math.random() * 180)
  await new Promise((resolve) => setTimeout(resolve, artificialDelayMs))

  return NextResponse.json(sipCalculate(Number(monthly), Number(years), Number(rate)))
}
