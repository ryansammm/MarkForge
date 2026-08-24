import { NextRequest, NextResponse } from 'next/server'
import { getShareStore } from '@/lib/server/share-store'
import { InvalidPathError } from '@/lib/file-store'
import type { ShareScope } from '@/lib/share'
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
 * Share management. **Authenticated** — this route is behind the password gate.
 *
 *   GET    /api/shares                 list every share, live and revoked
 *   POST   /api/shares                 create  { path, scope }
 *   DELETE /api/shares?token=…         revoke
 *
 * Note the plural. `/api/share/<token>` is the public read route; `/api/shares` is
 * the private management one. They are one character apart, which is a genuine
 * hazard: a naive `pathname.startsWith('/api/share')` in middleware would exempt
 * this route too and hand out the full share list — including live tokens — to
 * anyone. middleware.ts matches `/api/share/` with the trailing slash for exactly
 * that reason, and there is a regression test on it.
 */

function errorResponse(err: unknown): NextResponse {
  const limited = limitErrorResponse(err)
  if (limited) return limited

  if (err instanceof InvalidPathError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
  }
  captureError(err, { scope: 'api/shares', event: 'unhandled' })
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
}

export async function GET() {
  try {
    return NextResponse.json({ shares: await getShareStore().list() })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    const body = await readJsonBody<{
      path?: unknown
      scope?: unknown
      expiresInDays?: unknown
      password?: unknown
    }>(request, MAX_CONTROL_BYTES)

    if (typeof body.path !== 'string') {
      return NextResponse.json(
        { error: 'Body must be { path: string, scope: "document" | "subtree" }', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }
    if (body.scope !== 'document' && body.scope !== 'subtree') {
      return NextResponse.json(
        { error: 'scope must be "document" or "subtree"', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }
    if (body.expiresInDays !== undefined && typeof body.expiresInDays !== 'number') {
      return NextResponse.json(
        { error: 'expiresInDays must be a number of days', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }
    if (body.password !== undefined && typeof body.password !== 'string') {
      return NextResponse.json({ error: 'password must be a string', code: 'BAD_REQUEST' }, { status: 400 })
    }

    // The response carries a summary, never the hash — see ShareStore.list.
    const share = await getShareStore().create(body.path, body.scope as ShareScope, {
      expiresInDays: body.expiresInDays,
      password: body.password || undefined,
    })
    return NextResponse.json({ share }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    const token = request.nextUrl.searchParams.get('token')
    if (!token) {
      return NextResponse.json({ error: 'Missing token', code: 'BAD_REQUEST' }, { status: 400 })
    }

    const found = await getShareStore().revoke(token)
    if (!found) {
      return NextResponse.json({ error: 'No such share', code: 'NOT_FOUND' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, token })
  } catch (err) {
    return errorResponse(err)
  }
}
