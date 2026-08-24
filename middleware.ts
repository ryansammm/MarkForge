import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  mintSession,
  sessionSecret,
  shouldRenew,
  verifySession,
} from '@/lib/session'

/**
 * The access gate.
 *
 * What changed in Phase 2: the cookie no longer *is* `APP_PASSWORD`. It is a signed,
 * expiring token carrying no secret (lib/session.ts). A captured cookie is now a
 * time-limited session rather than the master password, and it cannot be forged
 * without the signing key.
 *
 * Verification is a pure HMAC check with no I/O, which is what lets it run here on
 * every request. There is no session store to consult — see the note at the end of
 * lib/session.ts for what that costs and why it is the right trade for now.
 */

/**
 * Routes that must answer before anyone is authenticated.
 *
 * TRAILING SLASHES ARE LOAD-BEARING. `/api/shares` (plural) is the *private*
 * management route that lists every share and its live tokens. It also starts with
 * the string `/api/share`, so a prefix test without the slash would exempt it and
 * hand out every token to anyone who asked. Same for `/share/` versus a hypothetical
 * `/shares`. tests/share.test.ts asserts both directions.
 *
 * The share exemption is only safe while resolution is by token alone. It was once
 * granted to a route that resolved by title, which published the entire corpus. If
 * share resolution ever accepts a human-readable name again, this exemption has to
 * go with it.
 */
function isPublic(pathname: string): boolean {
  return (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    // A health check that needs a credential is one nobody wires up. The payload is
    // kept to liveness and durability for exactly that reason.
    pathname === '/api/health' ||
    pathname.startsWith('/share/') ||
    pathname.startsWith('/api/share/') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    // These assets must remain public. Browsers fetch them before (and outside of)
    // an authenticated app session to determine whether this site is installable.
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/icon.svg' ||
    pathname === '/pwa-icon.svg' ||
    pathname === '/icon-192.png' ||
    pathname === '/icon-512.png'
  )
}

function deny(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  // API callers get an explicit 401. Redirecting them to /login would hand fetch()
  // a 200 full of HTML, and a save that failed on auth would be indistinguishable
  // from one that succeeded.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
  }

  const loginUrl = new URL('/login', request.url)
  loginUrl.searchParams.set('from', pathname)
  const response = NextResponse.redirect(loginUrl)
  // Clear whatever was presented. Most often it is simply expired, and leaving it in
  // place means every subsequent request re-does the same failing verification.
  response.cookies.delete(SESSION_COOKIE)
  return response
}

export async function middleware(request: NextRequest) {
  const secret = sessionSecret(process.env)
  // No password configured means no gate — the documented local-development case.
  if (!secret) return NextResponse.next()

  if (isPublic(request.nextUrl.pathname)) return NextResponse.next()

  const token = request.cookies.get(SESSION_COOKIE)?.value
  const payload = await verifySession(secret, token)
  if (!payload) return deny(request)

  const response = NextResponse.next()

  // Sliding expiry: someone using the app daily is never signed out, someone who
  // stops for a week is. Re-issued with the same sid, so the session keeps its
  // identity across renewals.
  if (shouldRenew(payload)) {
    response.cookies.set({
      name: SESSION_COOKIE,
      value: await mintSession(secret, { sid: payload.sid }),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
