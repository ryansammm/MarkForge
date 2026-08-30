import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/server/store'
import { readRegistry, createGrimoire } from '@/lib/server/grimoire'
import { addGrimoireToMarker } from '@/lib/server/grimoire-marker'
import { captureError } from '@/lib/server/observability'
import { devLog } from '@/lib/server/dev-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/grimoires — list all grimoires
 * POST /api/grimoires — create a new grimoire { name: string }
 */
export async function GET() {
  try {
    devLog.info('api/grimoires', 'list-start')
    const bucket = getStore().bucket
    const registry = await readRegistry(bucket)
    devLog.info('api/grimoires', 'list-done', { count: registry.grimoires.length })
    return NextResponse.json(registry)
  } catch (err) {
    devLog.error('api/grimoires', 'list-failed', { error: String(err) })
    captureError(err, { scope: 'api/grimoires', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    devLog.info('api/grimoires', 'create-start', { name: body.name })
    if (typeof body.name !== 'string' || !body.name.trim()) {
      devLog.warn('api/grimoires', 'create-bad-request')
      return NextResponse.json(
        { error: 'Body must be { name: string }', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    let externalPath: string | undefined
    if (typeof body.path === 'string' && body.path.trim()) {
      const p = body.path.trim()
      // Accept absolute paths only (Windows drive or POSIX root) so a relative
      // name can never be mistaken for a folder to back a grimoire.
      if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) {
        return NextResponse.json(
          { error: 'path must be an absolute folder path', code: 'BAD_REQUEST' },
          { status: 400 }
        )
      }
      externalPath = p
    }

    const bucket = getStore().bucket
    devLog.info('api/grimoires', 'create-got-bucket', { bucketKind: bucket.kind })
    const grimoire = await createGrimoire(bucket, body.name.trim(), { path: externalPath })
    if (externalPath) {
      // A grimoire created directly against a folder records itself in that
      // folder's .grimoire marker. The auto-pick flow goes through PUT {path}
      // and is handled there instead.
      await addGrimoireToMarker(externalPath, grimoire)
    }
    devLog.info('api/grimoires', 'create-done', { id: grimoire.id })
    return NextResponse.json(grimoire, { status: 201 })
  } catch (err) {
    devLog.error('api/grimoires', 'create-failed', { error: String(err) })
    if (err instanceof Error && err.message.includes('already exists')) {
      return NextResponse.json({ error: err.message, code: 'CONFLICT' }, { status: 409 })
    }
    captureError(err, { scope: 'api/grimoires', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}
