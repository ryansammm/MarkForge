import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, mintSession, sessionSecret } from '@/lib/session'
import { AUTH_LIMIT, checkRateLimit, clearRateLimit, clientKey } from '@/lib/server/rate-limit'
import { logSecurityEvent } from '@/lib/server/observability'
import { AppSettingsStore, resolveAppPin, DEFAULT_APP_PIN, isValidAppPin } from '@/lib/server/app-settings'
import { validateEnv } from '@/lib/server/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sign in and out.
 *
 *   POST   /api/auth   { pin }   → sets a signed session cookie
 *   DELETE /api/auth             → signs out
 *
 * Three things were wrong here and all three are fixed:
 *
 *   1. The cookie value **was** `APP_PASSWORD`. It is now a signed token carrying no
 *      secret (lib/session.ts).
 *   2. The comparison was `===`, which short-circuits on the first differing byte.
 *      It is now `timingSafeEqual` over fixed-length digests.
 *   3. There was no rate limit — unlimited guesses against one human-chosen
 *      password, with nothing logged. Five attempts per fifteen minutes per client
 *      now, cleared on success so one typo costs nothing.
 *
 * The gate credential is now a 6-digit PIN (`APP_PIN` env, or `app-settings.json`
 * in the bucket, or the default `123098`). The signing key is derived from the
 * resolved PIN in `lib/session.ts`; rotating the PIN invalidates every session.
 */

/**
 * Compares in constant time, regardless of length.
 *
 * `timingSafeEqual` throws on length mismatch, and catching that would leak the
 * length through timing anyway. Hashing both sides first makes every comparison the
 * same 32 bytes, so only equality is observable.
 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(a), digest(b)])
  return timingSafeEqual(left, right)
}

async function digest(value: string): Promise<Buffer> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Buffer.from(hash)
}

export async function POST(request: NextRequest) {
  // Run the env validator at request time (not boot) so warnings surface in
  // Vercel function logs without a deploy.
  const settings = new AppSettingsStore()
  const stored = await settings.load().catch(() => null)
  validateEnv(process.env, { hasStoredPin: stored?.appPin !== undefined })

  const expected = resolveAppPin(process.env, stored)
  const secret = sessionSecret({
    ...process.env,
    APP_PIN: expected,
  })

  // No PIN configured: the gate is off, and the middleware lets everything
  // through anyway. Minting a session here keeps the login page working rather than
  // looping someone through a form that cannot succeed.
  if (!secret) {
    return NextResponse.json({ success: true, gated: false })
  }

  const limit = checkRateLimit(clientKey(request, 'auth'), AUTH_LIMIT)
  if (!limit.ok) {
    logSecurityEvent('auth-rate-limited', { retryAfter: limit.retryAfter })
    // Deliberately the same shape as a wrong PIN, plus Retry-After. An attacker
    // learns they are being limited; they learn nothing about the PIN.
    return NextResponse.json(
      { error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
    )
  }

  let pin: unknown
  try {
    ;({ pin } = (await request.json()) as { pin?: unknown })
  } catch {
    return NextResponse.json({ error: 'Bad request', code: 'BAD_REQUEST' }, { status: 400 })
  }

  if (typeof pin !== 'string' || !isValidAppPin(pin) || !(await constantTimeEquals(pin, expected))) {
    // The attempt is recorded; the attempted PIN is not. A log full of
    // near-miss PINs is its own breach.
    logSecurityEvent('auth-failed', { remaining: limit.remaining })
    return NextResponse.json({ error: 'Invalid PIN', code: 'INVALID_PIN' }, { status: 401 })
  }

  clearRateLimit(clientKey(request, 'auth'))

  const response = NextResponse.json({ success: true, gated: true })
  response.cookies.set({
    name: SESSION_COOKIE,
    value: await mintSession(secret),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
  return response
}

/**
 * Signs out by clearing the cookie.
 *
 * This ends the session on this device only. There is no server-side revocation —
 * tokens are stateless by necessity (the middleware runs on the Edge runtime with no
 * store to consult), so a token already copied elsewhere remains valid until it
 * expires. Rotating `APP_PIN` or `SESSION_SECRET` is what invalidates every
 * session everywhere; lib/session.ts says so at the point it matters.
 */
export async function DELETE() {
  const response = NextResponse.json({ success: true })
  response.cookies.delete(SESSION_COOKIE)
  return response
}

// `DEFAULT_APP_PIN` is re-exported so the login page can show the seed in
// development without duplicating the constant.
export { DEFAULT_APP_PIN }
