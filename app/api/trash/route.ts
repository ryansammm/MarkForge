import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/server/store'
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
 * The trash.
 *
 *   GET    /api/trash                       list recoverable entries, newest first
 *   POST   /api/trash                       restore  { id }
 *   DELETE /api/trash[?olderThanDays=N]     purge past a retention window
 *
 * Behind the password gate, like every other management route. It has to be: the
 * trash holds the contents of documents somebody deliberately deleted, which makes
 * it strictly more sensitive than the corpus, not less.
 *
 * There is deliberately **no delete-one-entry endpoint.** Purge is by retention
 * only. A button that permanently destroys a specific recoverable document is the
 * exact thing this whole feature exists to remove from the product.
 *
 * `olderThanDays` is an operator control, reachable only with a request someone
 * writes by hand, and is deliberately absent from the UI. `olderThanDays=0` empties
 * the trash — the runbook case is a test suite that wrote into it, where every entry
 * is known junk. Nothing in the app can call it by accident.
 */

function errorResponse(err: unknown): NextResponse {
  const limited = limitErrorResponse(err)
  if (limited) return limited

  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 })
  }
  if (err instanceof InvalidPathError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
  }

  captureError(err, { scope: 'api/trash', event: 'unhandled' })
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
}

export async function GET() {
  try {
    const entries = await getStore().listTrash()
    return NextResponse.json({ entries }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    const body = await readJsonBody<{ id?: unknown }>(request, MAX_CONTROL_BYTES)
    if (typeof body.id !== 'string' || !body.id) {
      return NextResponse.json({ error: 'Body must be { id: string }', code: 'BAD_REQUEST' }, { status: 400 })
    }

    const result = await getStore().restoreFromTrash(body.id)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get('olderThanDays')
    if (raw !== null && !/^\d+$/.test(raw)) {
      return NextResponse.json(
        { error: 'olderThanDays must be a whole number of days', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    return NextResponse.json(
      await getStore().purgeTrash(raw === null ? {} : { retentionDays: Number(raw) })
    )
  } catch (err) {
    return errorResponse(err)
  }
}
