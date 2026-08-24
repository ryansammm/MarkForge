import { NextResponse } from 'next/server'
import { getStore } from '@/lib/server/store'
import { backendHealth } from '@/lib/server/store'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The live workspace index.
 *
 * The client used to fetch `/index.json` — the statically served build artifact.
 * That works locally, where the file on disk is the file the store writes, and
 * breaks completely on object storage, where the build artifact is a snapshot
 * frozen at deploy time and every edit made since is invisible.
 *
 * Reading through the store instead means the UI sees whatever the configured
 * backend actually holds.
 */
export async function GET() {
  try {
    const index = await getStore().getIndex()
    const health = backendHealth()

    return NextResponse.json(index, {
      headers: {
        'Cache-Control': 'no-store',
        // Surfaced as headers so the payload stays exactly a WorkspaceIndex.
        'X-Storage-Backend': health.kind,
        'X-Storage-Durable': String(health.durable),
      },
    })
  } catch (err) {
    captureError(err, { scope: 'api/index', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}
