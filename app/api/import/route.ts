import { NextRequest, NextResponse } from 'next/server'
import { resolveStore } from '@/lib/server/resolve-store'
import { InvalidPathError } from '@/lib/file-store'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Bulk import for drag-and-drop.
 *
 * The per-document PUT patches the index on every write, which is the right cost
 * for a user editing one file and the wrong one for dropping in a folder of them.
 * This endpoint writes every accepted document straight to the bucket and then
 * rebuilds the index exactly once - the same shape `scripts/sync-storage.ts` uses,
 * so bulk imports land in seconds instead of round-tripping the index N times.
 *
 * Create-only by design: paths already present are skipped, never overwritten -
 * matching `api.createDocument`, because a drop must not silently replace work.
 */

interface IncomingFile {
  path?: unknown
  content?: unknown
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof InvalidPathError) {
    return NextResponse.json({ error: err.message, code: err.code, path: err.path }, { status: 400 })
  }
  captureError(err, { scope: 'api/import', event: 'unhandled' })
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
}

export async function POST(request: NextRequest) {
  try {
    let parsed: { files?: IncomingFile[] }
    try {
      parsed = await request.json()
    } catch {
      return NextResponse.json({ error: 'Bad request', code: 'BAD_REQUEST' }, { status: 400 })
    }

    const files = Array.isArray(parsed.files) ? parsed.files : []
    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files to import', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    const store = await resolveStore(request)
    const existing = new Set(await store.bucket.listKeys())
    let copied = 0
    let skipped = 0

    for (const file of files) {
      if (typeof file?.path !== 'string' || typeof file?.content !== 'string') {
        return NextResponse.json(
          { error: 'Every entry needs a string path and content', code: 'BAD_REQUEST' },
          { status: 400 }
        )
      }
      // Store-owned validation: one source of truth for path safety.
      const key = store.validateDocumentKey(file.path)
      if (existing.has(key)) {
        skipped++
        continue
      }
      await store.bucket.writeText(key, file.content)
      existing.add(key)
      copied++
    }

    const index = copied > 0 ? await store.reindex() : null
    return NextResponse.json({
      copied,
      skipped,
      ...(index ? { documents: Object.keys(index.documents).length } : {}),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
