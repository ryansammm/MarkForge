import { NextResponse } from 'next/server'
import { backendHealth } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Liveness and durability, for an uptime monitor.
 *
 * **Public**, and exempt from the password gate, because a health check that needs a
 * credential is a health check nobody wires up. That makes the payload a deliberate
 * exercise in saying as little as possible: whether the process is up, which backend
 * class is configured, and whether writes survive. No counts, no paths, no versions,
 * nothing about the corpus.
 *
 * `durable: false` is the one that matters. The filesystem backend on an ephemeral
 * host accepts writes that vanish at the next cold start — the worst failure mode
 * there is, because it looks exactly like success. A monitor watching this field
 * catches a misconfigured deployment before a user's writing does.
 *
 * Answers 200 when up and 503 when writes would not survive, so a monitor with no
 * JSON parsing still notices.
 */
export async function GET() {
  const health = backendHealth()

  return NextResponse.json(
    {
      ok: health.durable,
      backend: health.kind,
      durable: health.durable,
      ...(health.warning ? { warning: health.warning } : {}),
      time: new Date().toISOString(),
    },
    {
      status: health.durable ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  )
}
