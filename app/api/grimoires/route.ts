import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/server/store'
import { readRegistry, createGrimoire } from '@/lib/server/grimoire'
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

    const bucket = getStore().bucket
    devLog.info('api/grimoires', 'create-got-bucket', { bucketKind: bucket.kind })
    const grimoire = await createGrimoire(bucket, body.name.trim())
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
