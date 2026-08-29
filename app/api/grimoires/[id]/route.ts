import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/server/store'
import {
  readRegistry,
  renameGrimoire,
  deleteGrimoire,
  setActiveGrimoire,
  setGrimoireRoot,
} from '@/lib/server/grimoire'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET    /api/grimoires/[id] — get grimoire details
 * PUT    /api/grimoires/[id] — rename { name: string } or activate { active: true }
 * DELETE /api/grimoires/[id] — delete grimoire
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const bucket = getStore().bucket
    const registry = await readRegistry(bucket)
    const grimoire = registry.grimoires.find((g) => g.id === id)
    if (!grimoire) {
      return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    return NextResponse.json({ ...grimoire, lastActiveId: registry.lastActiveId })
  } catch (err) {
    captureError(err, { scope: 'api/grimoires/[id]', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const bucket = getStore().bucket

    if (typeof body.name === 'string' && body.name.trim()) {
      const grimoire = await renameGrimoire(bucket, id, body.name.trim())
      return NextResponse.json(grimoire)
    }

    if (body.active === true) {
      const grimoire = await setActiveGrimoire(bucket, id)
      return NextResponse.json(grimoire)
    }

    if (typeof body.path === 'string' && body.path.trim()) {
      const p = body.path.trim()
      if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) {
        return NextResponse.json(
          { error: 'path must be an absolute folder path', code: 'BAD_REQUEST' },
          { status: 400 }
        )
      }
      const grimoire = await setGrimoireRoot(bucket, id, p)
      return NextResponse.json(grimoire)
    }

    return NextResponse.json(
      {
        error: 'Body must be { name: string }, { active: true }, or { path: string }',
        code: 'BAD_REQUEST',
      },
      { status: 400 }
    )
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found')) {
        return NextResponse.json({ error: err.message, code: 'NOT_FOUND' }, { status: 404 })
      }
      if (err.message.includes('already exists')) {
        return NextResponse.json({ error: err.message, code: 'CONFLICT' }, { status: 409 })
      }
    }
    captureError(err, { scope: 'api/grimoires/[id]', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const bucket = getStore().bucket
    await deleteGrimoire(bucket, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return NextResponse.json({ error: err.message, code: 'NOT_FOUND' }, { status: 404 })
    }
    captureError(err, { scope: 'api/grimoires/[id]', event: 'unhandled' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}
