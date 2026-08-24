import { NextRequest, NextResponse } from 'next/server'
import { getShareStore } from '@/lib/server/share-store'
import { AUTH_LIMIT, checkRateLimit, clientKey } from '@/lib/server/rate-limit'
import { MAX_CONTROL_BYTES, readJsonBody } from '@/lib/server/request-limits'
import { mintSession, sessionSecret, verifySession } from '@/lib/session'
import { captureError, logSecurityEvent } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Public share read. The only unauthenticated route in the app.
 *
 *   GET  /api/share/<token>              the shared document
 *   GET  /api/share/<token>?path=a/b.md  a document inside a subtree share
 *   POST /api/share/<token>              unlock a protected share  { password }
 *
 * **Every failure is a 404 with an identical body.** Unknown token, revoked token,
 * expired token, a path outside the share's scope, a deleted file — all the same
 * response. PRD R8: a 403 confirms the resource exists, which turns a revoked link
 * into an existence oracle and tells an attacker when a guess was structurally right.
 *
 * The single exception is 401 `PASSWORD_REQUIRED`, and it is returned **only to
 * someone who already presented a valid live token** — they have the link, so they
 * already know the share exists. Everything they could learn from that 401 they
 * learned by holding the URL.
 *
 * Nothing here accepts a title, a document id, or an arbitrary path as the key.
 * The token is the credential.
 */

const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' } as const

/** How long an unlock lasts before the password is asked for again. */
const UNLOCK_TTL_SECONDS = 12 * 60 * 60

const PUBLIC_HEADERS = {
  // Never cache: a revoked or expired share must stop working immediately, and a
  // shared CDN copy would outlive the revocation.
  'Cache-Control': 'no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

function unlockCookieName(token: string): string {
  // Scoped per share, so unlocking one protected link does not unlock another.
  return `share_unlock_${token}`
}

/** Whether this request already proved it knows the share's password. */
async function isUnlocked(request: NextRequest, token: string): Promise<boolean> {
  const secret = sessionSecret(process.env)
  if (!secret) return false

  const payload = await verifySession(secret, request.cookies.get(unlockCookieName(token))?.value)
  // The sid is bound to the token: a cookie minted for one share cannot unlock
  // another, even though both are signed with the same key.
  return payload?.sid === `share:${token}`
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const requestedPath = request.nextUrl.searchParams.get('path') ?? undefined

    const result = await getShareStore().resolve(token, requestedPath, {
      unlocked: await isUnlocked(request, token),
    })

    if (!result) return NextResponse.json(NOT_FOUND, { status: 404, headers: PUBLIC_HEADERS })

    if (result.kind === 'locked') {
      return NextResponse.json(
        { error: 'This link is password protected.', code: 'PASSWORD_REQUIRED', label: result.label },
        { status: 401, headers: PUBLIC_HEADERS }
      )
    }

    return NextResponse.json(result.lookup.response, { headers: PUBLIC_HEADERS })
  } catch (err) {
    // Reported internally, answered as 404 externally. The reader must not be able to
    // tell an internal fault from a bad token — a 500 on a valid token and a 404 on an
    // invalid one are distinguishable, and that is the leak.
    captureError(err, { scope: 'api/share', event: 'read-failed' })
    return NextResponse.json(NOT_FOUND, { status: 404, headers: PUBLIC_HEADERS })
  }
}

/**
 * Unlocks a password-protected share.
 *
 * Rate-limited per token and client: this is a password-guessing surface on an
 * unauthenticated route, which makes it the most exposed thing in the app. A wrong
 * password and a token that does not exist both answer 404, so this cannot be used
 * to enumerate which tokens are real.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params

    const limit = checkRateLimit(`${clientKey(request, 'unlock')}:${token}`, AUTH_LIMIT)
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' },
        { status: 429, headers: { ...PUBLIC_HEADERS, 'Retry-After': String(limit.retryAfter) } }
      )
    }

    const body = await readJsonBody<{ password?: unknown }>(request, MAX_CONTROL_BYTES)
    const password = typeof body.password === 'string' ? body.password : ''

    const secret = sessionSecret(process.env)
    if (!secret || !(await getShareStore().checkPassword(token, password))) {
      // Worth finding in a log: repeated failures against one token are somebody
      // working on a link they were given, or one they guessed. The token itself is
      // never logged — it is the credential.
      logSecurityEvent('share-unlock-failed', { remaining: limit.remaining })
      return NextResponse.json(NOT_FOUND, { status: 404, headers: PUBLIC_HEADERS })
    }

    const response = NextResponse.json({ ok: true }, { headers: PUBLIC_HEADERS })
    response.cookies.set({
      name: unlockCookieName(token),
      value: await mintSession(secret, { sid: `share:${token}`, ttlSeconds: UNLOCK_TTL_SECONDS }),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: UNLOCK_TTL_SECONDS,
    })
    return response
  } catch (err) {
    captureError(err, { scope: 'api/share', event: 'unlock-failed' })
    return NextResponse.json(NOT_FOUND, { status: 404, headers: PUBLIC_HEADERS })
  }
}
