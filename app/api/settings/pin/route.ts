import { NextRequest, NextResponse } from 'next/server'
import { sessionSecret, verifySession } from '@/lib/session'
import { AppSettingsStore, isValidAppPin, InvalidAppSettingsError } from '@/lib/server/app-settings'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * App PIN settings.
 *
 *   GET  /api/settings/pin    → { pin: string | null }   (null = env/default)
 *   PUT  /api/settings/pin    → { pin: string }          (writes to bucket)
 *
 * The PIN gate is satisfied at the middleware; this route adds a second check
 * because the auth-exempt list in middleware is a string-prefix test one edit
 * away from being wrong (see the `/api/shares` note there).
 *
 * The route does not log PINs. A log line carrying the user's PIN is its own
 * breach, so even successful writes are silent apart from the shape of the
 * request.
 */

async function unauthorized(request: NextRequest): Promise<NextResponse | null> {
  const secret = sessionSecret(process.env)
  if (!secret) return null
  const token = request.cookies.get('morrow_session')?.value
  const payload = await verifySession(secret, token)
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
  }
  return null
}

export async function GET(request: NextRequest) {
  const denied = await unauthorized(request)
  if (denied) return denied

  try {
    const store = new AppSettingsStore()
    const settings = await store.load()
    return NextResponse.json({ pin: settings?.appPin ?? null })
  } catch (err) {
    captureError(err, { scope: 'api/settings/pin', event: 'get-failed' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const denied = await unauthorized(request)
  if (denied) return denied

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Bad request', code: 'BAD_REQUEST' }, { status: 400 })
  }

  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const pin = record.pin
  if (typeof pin !== 'string' || !isValidAppPin(pin)) {
    return NextResponse.json(
      { error: 'pin must be exactly 6 digits', code: 'INVALID_PIN' },
      { status: 400 }
    )
  }

  try {
    const store = new AppSettingsStore()
    const next = await store.setAppPin(pin)
    return NextResponse.json({ pin: next.appPin, updatedAt: next.updatedAt })
  } catch (err) {
    if (err instanceof InvalidAppSettingsError) {
      return NextResponse.json({ error: err.message, code: 'INVALID_APP_SETTINGS' }, { status: 400 })
    }
    captureError(err, { scope: 'api/settings/pin', event: 'put-failed' })
    return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
  }
}
