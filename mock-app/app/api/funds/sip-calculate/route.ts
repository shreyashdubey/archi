import { NextResponse } from 'next/server'
import { sipCalculate } from '@mock/data'

/**
 * Mock SIP calculation API. The calculator fetches this on every change, so the
 * instrumentation records an ApiCall event with the real round-trip duration.
 * A small artificial delay makes the API timing visible in the telemetry.
 */
export async function POST(req: Request) {
  const { monthly = 25000, years = 2, rate = 15 } = await req.json().catch(() => ({}))
  await new Promise((r) => setTimeout(r, 120 + Math.round(Math.random() * 180)))
  return NextResponse.json(sipCalculate(Number(monthly), Number(years), Number(rate)))
}
