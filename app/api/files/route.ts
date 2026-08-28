import { NextRequest, NextResponse } from 'next/server'
import { ConflictError, InvalidPathError, NotFoundError } from '@/lib/file-store'
import {
  MAX_CONTROL_BYTES,
  MAX_DOCUMENT_BYTES,
  enforceWriteRate,
  limitErrorResponse,
  readJsonBody,
} from '@/lib/server/request-limits'
import { captureError } from '@/lib/server/observability'
import { getSearchIndex } from '@/lib/server/search'
import { resolveStore } from '@/lib/server/resolve-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Document read/write endpoint — the HTTP face of the R1 FileStore write surface.
 *
 *   GET    /api/files?path=a/b.md      read a document (etag in the ETag header)
 *   PUT    /api/files?path=a/b.md      write, honouring If-Match
 *   DELETE /api/files?path=a/b.md      remove, honouring If-Match
 *   POST   /api/files                  move/rename  { from, to }
 *
 * If-Match mismatches are refused with 409 and the current etag — the file on
 * storage is somebody else's newer work, and overwriting it is the one outcome that
 * must not happen. The refused content is written to `conflictPath` rather than left
 * to live only in a browser buffer.
 */

function errorResponse(err: unknown): NextResponse {
  const limited = limitErrorResponse(err)
  if (limited) return limited

  if (err instanceof ConflictError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        path: err.path,
        expectedEtag: err.expectedEtag,
        actualEtag: err.actualEtag,
        // Where the rejected text was preserved. The client shows this: a refusal
        // the user cannot act on is only marginally better than silent loss.
        conflictPath: err.conflictPath,
      },
      { status: 409 }
    )
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 })
  }
  if (err instanceof InvalidPathError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
  }

  captureError(err, { scope: 'api/files', event: 'unhandled' })
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
}

function requirePath(request: NextRequest): string {
  const value = request.nextUrl.searchParams.get('path')
  if (!value) throw new InvalidPathError('', 'missing "path" query parameter')
  return value
}

/** `If-Match: "abc"` — tolerate the quoted form as well as a bare value. */
function ifMatch(request: NextRequest): string | undefined {
  const header = request.headers.get('if-match')
  if (!header) return undefined
  return header.trim().replace(/^"(.*)"$/, '$1')
}

export async function GET(request: NextRequest) {
  try {
    const store = await resolveStore(request)
    const result = await store.readDocument(requirePath(request))
    if (!result) {
      return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    // `raw` is the complete file including frontmatter — what the editor loads.
    // `document` is the index entry, whose `content` is the body alone.
    return NextResponse.json(
      { document: result.document, raw: result.raw },
      {
        headers: {
          ETag: `"${result.document.etag}"`,
          'Cache-Control': 'no-store',
        },
      }
    )
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    const path = requirePath(request)
    const body = await readJsonBody<{ content?: unknown }>(request, MAX_DOCUMENT_BYTES)

    if (typeof body.content !== 'string') {
      return NextResponse.json(
        { error: 'Body must be { content: string }', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    const store = await resolveStore(request)
    const result = await store.write(path, body.content, { ifMatch: ifMatch(request) })

    // So a document is findable the instant it is saved. Every other mutation — a
    // rename, a folder move, a restore, a write on another instance — is caught by
    // the search index reconciling against document etags a few seconds later.
    getSearchIndex(store).noteWritten(
      result.path,
      result.document.content ?? '',
      result.document.title,
      result.etag
    )

    return NextResponse.json(result, {
      headers: { ETag: `"${result.etag}"`, 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    const store = await resolveStore(request)
    const result = await store.remove(requirePath(request), { ifMatch: ifMatch(request) })
    getSearchIndex(store).noteRemoved(result.path)
    // `trashId` is what makes the delete undoable — see /api/trash.
    return NextResponse.json({ ok: true, ...result })
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

    const result = await (await resolveStore(request)).move(body.from, body.to, { ifMatch: ifMatch(request) })

    return NextResponse.json(result, {
      headers: { ETag: `"${result.etag}"`, 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
