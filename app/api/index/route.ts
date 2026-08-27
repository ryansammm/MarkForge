import { NextResponse } from 'next/server'
import { backendHealth } from '@/lib/server/store'
import { resolveStore } from '@/lib/server/resolve-store'
import { captureError } from '@/lib/server/observability'
import { devLog } from '@/lib/server/dev-log'
import type { NextRequest } from 'next/server'

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
export async function GET(request: NextRequest) {
  const grimoireId = request.headers.get('x-grimoire-id')
  devLog.info('api/index', 'request', { grimoireId: grimoireId ?? '(default)' })

  try {
    devLog.info('api/index', 'resolving-store')
    const store = await resolveStore(request)
    devLog.info('api/index', 'store-resolved', { grimoireId: store.grimoireId ?? '(default)' })

    devLog.info('api/index', 'fetching-index')
    const index = await store.getIndex()
    devLog.info('api/index', 'index-fetched', {
      documents: Object.keys(index.documents).length,
      tree: index.tree.length,
    })

    const health = backendHealth()
    devLog.info('api/index', 'done')

    return NextResponse.json(index, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Storage-Backend': health.kind,
        'X-Storage-Durable': String(health.durable),
      },
    })
  } catch (err) {
    devLog.error('api/index', 'failed', { error: String(err) })
    captureError(err, { scope: 'api/index', event: 'unhandled' })
    const status = (err as any)?.code === 'GRIMOIRE_NOT_FOUND' ? 404 : 500
    return NextResponse.json({ error: (err as Error).message, code: (err as any)?.code ?? 'INTERNAL' }, { status })
  }
}
