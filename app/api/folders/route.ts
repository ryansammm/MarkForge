import { NextRequest, NextResponse } from 'next/server'
import { resolveStore } from '@/lib/server/resolve-store'
import { ConflictError, InvalidPathError, NotFoundError } from '@/lib/file-store'
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
 * Folder operations.
 *
 *   PUT    /api/folders?path=a/b     create (parents included)
 *   POST   /api/folders              move   { from, to }
 *   DELETE /api/folders?path=a/b     delete the folder and everything under it
 *
 * Deletes are recursive. They go to the trash and report a `trashId`, so the confirm
 * in the UI is a courtesy rather than the last line of defence.
 */

function errorResponse(err: unknown): NextResponse {
  const limited = limitErrorResponse(err)
  if (limited) return limited

  if (err instanceof ConflictError) {
    return NextResponse.json({ error: err.message, code: err.code, path: err.path }, { status: 409 })
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 })
  }
  if (err instanceof InvalidPathError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
  }

  captureError(err, { scope: 'api/folders', event: 'unhandled' })
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
}

function requirePath(request: NextRequest): string {
  const value = request.nextUrl.searchParams.get('path')
  if (!value) throw new InvalidPathError('', 'missing "path" query parameter')
  return value
}

export async function PUT(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    return NextResponse.json(await (await resolveStore(request)).createDirectory(requirePath(request)))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    return NextResponse.json(await (await resolveStore(request)).removeDirectory(requirePath(request)))
  } catch (err) {
    return errorResponse(err)
  }
}

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

    return NextResponse.json(await (await resolveStore(request)).moveDirectory(body.from, body.to))
  } catch (err) {
    return errorResponse(err)
  }
}
