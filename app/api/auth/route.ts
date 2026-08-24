import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, mintSession, sessionSecret } from '@/lib/session'
import { AUTH_LIMIT, checkRateLimit, clearRateLimit, clientKey } from '@/lib/server/rate-limit'
import { logSecurityEvent } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sign in and out.
 *
 *   POST   /api/auth   { password }   → sets a signed session cookie
 *   DELETE /api/auth                  → signs out
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
  const expected = process.env.APP_PASSWORD
  const secret = sessionSecret(process.env)

  // No password configured: the gate is off, and the middleware lets everything
  // through anyway. Minting a session here keeps the login page working rather than
  // looping someone through a form that cannot succeed.
  if (!expected || !secret) {
    return NextResponse.json({ success: true, gated: false })
  }

  const limit = checkRateLimit(clientKey(request, 'auth'), AUTH_LIMIT)
  if (!limit.ok) {
    logSecurityEvent('auth-rate-limited', { retryAfter: limit.retryAfter })
    // Deliberately the same shape as a wrong password, plus Retry-After. An attacker
    // learns they are being limited; they learn nothing about the password.
    return NextResponse.json(
      { error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
    )
  }

  let password: unknown
  try {
    ;({ password } = (await request.json()) as { password?: unknown })
  } catch {
    return NextResponse.json({ error: 'Bad request', code: 'BAD_REQUEST' }, { status: 400 })
  }

  if (typeof password !== 'string' || !(await constantTimeEquals(password, expected))) {
    // The attempt is recorded; the attempted password is not. A log full of
    // near-miss passwords is its own breach.
    logSecurityEvent('auth-failed', { remaining: limit.remaining })
    return NextResponse.json({ error: 'Invalid password', code: 'INVALID_PASSWORD' }, { status: 401 })
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
 * expires. Rotating `APP_PASSWORD` or `SESSION_SECRET` is what invalidates every
 * session everywhere; lib/session.ts says so at the point it matters.
 */
export async function DELETE() {
  const response = NextResponse.json({ success: true })
  response.cookies.delete(SESSION_COOKIE)
  return response
}
