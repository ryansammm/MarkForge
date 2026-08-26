import { NextRequest, NextResponse } from 'next/server'
import { resolveStore } from '@/lib/server/resolve-store'
import { executeRename, planRename, summarizeRename } from '@/lib/server/rename'
import { InvalidPathError, NotFoundError } from '@/lib/file-store'
import {
  MAX_CONTROL_BYTES,
  enforceWriteRate,
  limitErrorResponse,
  readJsonBody,
} from '@/lib/server/request-limits'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Rename a document and rewrite the links pointing at it.
 *
 *   POST /api/rename            { from, to }            execute
 *   POST /api/rename?dryRun=1   { from, to }            return the changeset only
 *
 * The dry run exists so the UI can tell the user "this will update 12 documents"
 * before they commit to something with no undo.
 *
 * Always returns 200 with a report when the rename ran, including when some link
 * updates failed. A partial failure is not a failed request — it is a result the
 * user has to see per-file, which is the whole point of the report.
 */

export async function POST(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    const body = await readJsonBody<{ from?: unknown; to?: unknown }>(request, MAX_CONTROL_BYTES)

    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      return NextResponse.json(
        { error: 'Body must be { from: string, to: string }', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    const store = await resolveStore(request)
    const plan = await planRename(store, body.from, body.to)

    if (request.nextUrl.searchParams.get('dryRun')) {
      return NextResponse.json({ plan })
    }

    const report = await executeRename(store, plan)
    return NextResponse.json({ report, summary: summarizeRename(report) })
  } catch (err) {
    const limited = limitErrorResponse(err)
    if (limited) return limited

    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 })
    }
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }

    const message = (err as Error).message
    if (message.startsWith('Cannot rename:')) {
      return NextResponse.json({ error: message, code: 'NOT_FOUND' }, { status: 404 })
    }

    captureError(err, { scope: 'api/rename', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}
