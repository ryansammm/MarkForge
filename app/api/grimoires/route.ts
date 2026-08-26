import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/server/store'
import { readRegistry, createGrimoire } from '@/lib/server/grimoire'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/grimoires — list all grimoires
 * POST /api/grimoires — create a new grimoire { name: string }
 */
export async function GET() {
  try {
    const bucket = getStore().bucket
    const registry = await readRegistry(bucket)
    return NextResponse.json(registry)
  } catch (err) {
    captureError(err, { scope: 'api/grimoires', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json(
        { error: 'Body must be { name: string }', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    const bucket = getStore().bucket
    const grimoire = await createGrimoire(bucket, body.name.trim())
    return NextResponse.json(grimoire, { status: 201 })
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      return NextResponse.json({ error: err.message, code: 'CONFLICT' }, { status: 409 })
    }
    captureError(err, { scope: 'api/grimoires', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}
