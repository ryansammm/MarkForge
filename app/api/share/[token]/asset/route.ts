import { NextRequest, NextResponse } from 'next/server'
import { getShareStore } from '@/lib/server/share-store'
import { sessionSecret, verifySession } from '@/lib/session'
import { captureError } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Images inside a public share.
 *
 *   GET /api/share/<token>/asset?path=assets/2026/…png
 *
 * The second unauthenticated route in the app, and it lives under `/api/share/`
 * because that prefix — **with its trailing slash** — is what middleware.ts exempts
 * from the password gate. Anywhere else it would be behind the session and every
 * image on every shared page would come back 401.
 *
 * **Every failure is a 404 with an identical body.** Unknown token, revoked, expired,
 * locked, a path that is not an image, an image no in-scope document references, an
 * image that is not in storage: one response. The reasoning is the document route's,
 * unchanged — a 403 for "out of scope" would confirm that an image exists somewhere
 * the reader cannot see, which is exactly the oracle the share model is built to deny.
 *
 * There is no `PASSWORD_REQUIRED` counterpart here. That exception exists so a locked
 * *page* can say why it is empty; an image has no such story to tell, so a locked
 * share simply serves nothing.
 */

const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' } as const

const PUBLIC_HEADERS = {
  /**
   * Not cached, deliberately — the opposite of `/api/assets`.
   *
   * There the key is content-addressed and the reader is authenticated, so `immutable`
   * is free. Here the *token* is the credential, and a revoked share must stop working
   * at once. A cached copy of a shared image would outlive the revocation that was
   * supposed to take it away.
   */
  'Cache-Control': 'no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
  // User-supplied bytes, served same-origin to anyone with a link. See /api/assets.
  'X-Content-Type-Options': 'nosniff',
} as const

/** Whether this request already proved it knows the share's password. */
async function isUnlocked(request: NextRequest, token: string): Promise<boolean> {
  const secret = sessionSecret(process.env)
  if (!secret) return false

  const payload = await verifySession(secret, request.cookies.get(`share_unlock_${token}`)?.value)
  return payload?.sid === `share:${token}`
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const path = request.nextUrl.searchParams.get('path') ?? ''

    const asset = await getShareStore().resolveAsset(token, path, {
      unlocked: await isUnlocked(request, token),
    })

    if (!asset) return NextResponse.json(NOT_FOUND, { status: 404, headers: PUBLIC_HEADERS })

    return new NextResponse(Buffer.from(asset.bytes), {
      headers: {
        ...PUBLIC_HEADERS,
        'Content-Type': asset.contentType,
        'Content-Length': String(asset.bytes.byteLength),
      },
    })
  } catch (err) {
    // Reported internally, answered as 404 externally: a 500 on a valid token and a
    // 404 on an invalid one are distinguishable, and that difference is the leak.
    captureError(err, { scope: 'api/share/asset', event: 'read-failed' })
    return NextResponse.json(NOT_FOUND, { status: 404, headers: PUBLIC_HEADERS })
  }
}
