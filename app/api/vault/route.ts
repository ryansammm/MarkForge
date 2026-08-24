import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, sessionSecret, verifySession } from '@/lib/session'
import {
  MAX_VAULT_BYTES,
  VAULT_CREATE_ONLY,
  VaultConflictError,
  VaultCorruptError,
  getVaultStore,
} from '@/lib/server/vault-store'
import { InvalidVaultRecordError, parseVaultEnvelope } from '@/lib/vault/record'
import { enforceWriteRate, limitErrorResponse, readJsonBody } from '@/lib/server/request-limits'
import { captureError, logSecurityEvent } from '@/lib/server/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The encrypted vault. **Private, and ciphertext in both directions.**
 *
 *   GET /api/vault                → { record } | { record: null }
 *   PUT /api/vault  If-Match: rev → stores a new record, returns its revision
 *
 * The bootstrap write sends `If-Match: "*none*"`, exactly as `/api/files` does for a
 * create. There is no unconditional write and no DELETE: a route that can destroy the
 * vault is a route that can destroy it by accident, and the recovery story for that is
 * "restore a backup" either way.
 *
 * What this route knows: base64, a KDF descriptor, and a revision. What it never sees:
 * the master password, the derived key, or a single field of a credential. That is not
 * a convention — `parseVaultEnvelope` rejects any field the format does not name, so a
 * client that tried to send a site name alongside the ciphertext gets a 400.
 *
 * Nothing here is logged beyond the shape of the request. An error carrying a vault
 * body into a log aggregator would defeat the entire feature, so bodies never reach
 * `captureError` — only the route name and the event.
 */

/**
 * A second lock on the most sensitive route in the app.
 *
 * middleware.ts already refuses an unauthenticated `/api/vault`, so this is redundant
 * — today. It is here because that exemption list is a string-prefix test one edit
 * away from being wrong (see the `/api/shares` note in middleware.ts, which is exactly
 * that mistake caught once already), and because verifying an HMAC costs microseconds.
 *
 * With no password configured there is no gate anywhere in the app, and inventing one
 * here would make local development impossible while protecting nothing.
 */
async function unauthorized(request: NextRequest): Promise<NextResponse | null> {
  const secret = sessionSecret(process.env)
  if (!secret) return null

  const payload = await verifySession(secret, request.cookies.get(SESSION_COOKIE)?.value)
  if (payload) return null

  logSecurityEvent('vault-unauthenticated')
  return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
}

function errorResponse(err: unknown): NextResponse {
  const limited = limitErrorResponse(err)
  if (limited) return limited

  if (err instanceof VaultConflictError) {
    return NextResponse.json(
      { error: err.message, code: err.code, actualRevision: err.actualRevision },
      { status: 409 }
    )
  }
  if (err instanceof VaultCorruptError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 500 })
  }
  if (err instanceof InvalidVaultRecordError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
  }

  // Shape only. The body of a failed vault write is the vault.
  captureError(err, { scope: 'api/vault', event: 'unhandled' })
  return NextResponse.json({ error: 'Internal error', code: 'INTERNAL' }, { status: 500 })
}

/** `If-Match: "abc"` — the quoted form and the bare value both work, as in /api/files. */
function ifMatch(request: NextRequest): string | undefined {
  const header = request.headers.get('if-match')
  if (!header) return undefined
  return header.trim().replace(/^"(.*)"$/, '$1')
}

export async function GET(request: NextRequest) {
  const denied = await unauthorized(request)
  if (denied) return denied

  try {
    const record = await getVaultStore().read()

    // No ETag header. The revision travels in the body, where it is not copied into
    // every proxy and access log that records response headers.
    return NextResponse.json({ record }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(request: NextRequest) {
  const denied = await unauthorized(request)
  if (denied) return denied

  try {
    const limited = enforceWriteRate(request)
    if (limited) return limited

    const expected = ifMatch(request)
    if (!expected) {
      return NextResponse.json(
        {
          error: `Missing If-Match. Send the revision you loaded, or "${VAULT_CREATE_ONLY}" to create the vault.`,
          code: 'BAD_REQUEST',
        },
        { status: 400 }
      )
    }

    const body = await readJsonBody<unknown>(request, MAX_VAULT_BYTES)
    // Throws on any field the format does not name, including one carrying plaintext.
    const envelope = parseVaultEnvelope(body)

    const record = await getVaultStore().write(envelope, { ifMatch: expected })

    // The ciphertext is not echoed back — the client already has it, and every extra
    // copy in flight is another place it can be captured.
    return NextResponse.json(
      { revision: record.revision, updatedAt: record.updatedAt },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    return errorResponse(err)
  }
}
