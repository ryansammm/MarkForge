import { NextResponse } from 'next/server'
import { WRITE_LIMIT, checkRateLimit, clientKey } from './rate-limit'

/**
 * Limits on the authenticated write surface.
 *
 * `/api/files`, `/api/folders`, `/api/rename`, `/api/shares` and `/api/trash` had no
 * rate limit and no request-size cap. Being behind the password gate is not a limit:
 * one authenticated client — or one runaway loop in a browser tab — could fill the
 * bucket, and object storage bills by what is in it.
 *
 * Both failures are reported at the edge of the route with a status that says what
 * happened (429, 413) rather than surfacing as a generic 500 from deep inside the
 * store, where the caller cannot tell a transient fault from a refusal.
 */

/**
 * Ceiling for a single document.
 *
 * Generous for Markdown — an unusually long note is tens of kilobytes — and small
 * enough that a pathological write cannot do real damage. Documents that legitimately
 * approach this are a different product.
 */
export const MAX_DOCUMENT_BYTES = 1024 * 1024

/** Ceiling for a JSON control message: a rename, a share, a restore. */
export const MAX_CONTROL_BYTES = 64 * 1024

/**
 * Ceiling for a single uploaded image.
 *
 * Defined in lib/asset-limits.ts, because the editor needs the same number to shrink a
 * photo to fit before sending it, and this module cannot be imported by a browser.
 * Re-exported here so server callers keep one import for their limits.
 */
export { MAX_ASSET_BYTES } from '../asset-limits'

export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE'
  constructor(
    readonly bytes: number,
    readonly limit: number
  ) {
    super(`Request body is ${bytes} bytes; the limit is ${limit}.`)
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * Rate-limits a mutating request. Returns a 429 to send back, or null to continue.
 *
 * Per-instance, like everything in rate-limit.ts. Stated there, restated here so a
 * reader of this file does not have to infer that it is a distributed limiter. It is
 * not one.
 */
export function enforceWriteRate(request: Request): NextResponse | null {
  const limit = checkRateLimit(clientKey(request, 'write'), WRITE_LIMIT)
  if (limit.ok) return null

  return NextResponse.json(
    { error: 'Too many requests. Slow down and try again.', code: 'RATE_LIMITED' },
    { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
  )
}

/**
 * Reads a JSON body, refusing anything over `maxBytes`.
 *
 * `Content-Length` is checked first because it is free, and then the body is measured
 * as it is read — a client can lie about the header, or omit it entirely with chunked
 * encoding, so the header is an optimisation and the measurement is the check.
 */
export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  assertDeclaredSize(request, maxBytes)

  const text = await request.text()
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) throw new PayloadTooLargeError(bytes, maxBytes)

  try {
    return JSON.parse(text) as T
  } catch {
    throw new SyntaxError('Body is not valid JSON')
  }
}

/**
 * Refuses a body whose `Content-Length` already exceeds the limit.
 *
 * The cheap half of the check, and only the cheap half: a client can understate the
 * header or omit it entirely with chunked encoding. Whatever reads the body still has
 * to measure what actually arrived.
 */
export function assertDeclaredSize(request: Request, maxBytes: number): void {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(declared, maxBytes)
  }
}

/** Shared error mapping for the two failures this module raises. */
export function limitErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof PayloadTooLargeError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 413 })
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: 'Body is not valid JSON', code: 'BAD_REQUEST' }, { status: 400 })
  }
  return null
}
