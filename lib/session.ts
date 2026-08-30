/**
 * Signed session tokens.
 *
 * Replaces the gate where **the cookie value *was* `APP_PASSWORD`**: the master
 * secret sat verbatim in every browser's cookie jar and rode along with every
 * request, so any log, proxy, or backup that captured a cookie header captured the
 * password itself. It also never expired and could not be invalidated.
 *
 * A token here proves someone knew the password at a point in time. It carries no
 * secret, expires on its own, and cannot be edited without the signing key.
 *
 *   v1.<base64url payload>.<base64url HMAC-SHA256>
 *
 * **Web Crypto only, no Node builtins.** This module is imported by the middleware,
 * which runs on the Edge runtime — no `node:crypto`, and no bucket to read a session
 * record from. Verification has to be a pure computation over the cookie, on every
 * request, which is exactly what an HMAC is for.
 */

export const SESSION_COOKIE = 'morrow_session'

/** Seven days. Long enough to be usable, short enough that a stolen cookie dies. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Re-issue once a token is past this fraction of its life.
 *
 * The sliding window: someone using the app daily is never logged out, and someone
 * who stops for a week is. Refreshing on every request would rewrite the cookie
 * constantly for no benefit.
 */
const RENEW_AFTER = 0.5

export interface SessionPayload {
  /** Session id. Random, opaque, and not derived from anything. */
  sid: string
  /** Issued at, seconds since epoch. */
  iat: number
  /** Expires at, seconds since epoch. */
  exp: number
}

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * The signing key.
 *
 * `SESSION_SECRET` when set. Otherwise derived from `APP_PIN`, which has a
 * property worth stating plainly: **rotating the PIN invalidates every session**.
 * That is the "sign out everywhere" control, and it is the honest one available
 * without a shared session store — see the note at the bottom of this file.
 */
export function sessionSecret(env: Record<string, string | undefined>): string | null {
  const explicit = env.SESSION_SECRET?.trim()
  if (explicit) return explicit

  const pin = env.APP_PIN?.trim()
  if (!pin) return null
  // Namespaced so the signing key is never byte-identical to the PIN, even
  // before it goes through HMAC. v2 supersedes the v1 namespace used when the
  // gate was `APP_PASSWORD`; old cookies are no longer valid, which is the
  // intended forced re-login on this rename.
  return `morrow-session-v2:pin:${pin}`
}

async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

/** Length-safe, content-independent comparison. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}

export async function mintSession(
  secret: string,
  options: { now?: number; ttlSeconds?: number; sid?: string } = {}
): Promise<string> {
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS

  const payload: SessionPayload = {
    sid: options.sid ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    iat: now,
    exp: now + ttl,
  }

  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(encoded))

  return `v1.${encoded}.${toBase64Url(new Uint8Array(signature))}`
}

/**
 * Verifies a token and returns its payload, or null.
 *
 * Null for everything: wrong shape, wrong version, bad signature, unparseable
 * payload, expired. Callers get one answer and cannot accidentally distinguish
 * "tampered" from "expired" in a response.
 */
export async function verifySession(
  secret: string,
  token: string | undefined,
  now: number = Date.now()
): Promise<SessionPayload | null> {
  if (!token) return null

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null

  const [, encoded, signature] = parts
  const provided = fromBase64Url(signature)
  if (!provided) return null

  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(encoded))
  )
  if (!timingSafeEqual(provided, expected)) return null

  const decoded = fromBase64Url(encoded)
  if (!decoded) return null

  let payload: SessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded)) as SessionPayload
  } catch {
    return null
  }

  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || !payload.sid) return null
  if (payload.exp * 1000 <= now) return null

  return payload
}

/** Whether a valid token is old enough to be worth re-issuing. */
export function shouldRenew(payload: SessionPayload, now: number = Date.now()): boolean {
  const lifetime = payload.exp - payload.iat
  if (lifetime <= 0) return false
  const elapsed = now / 1000 - payload.iat
  return elapsed > lifetime * RENEW_AFTER
}

/**
 * Known limitation, stated rather than hidden.
 *
 * There is no per-session revocation list. Doing it properly means a shared store,
 * and the middleware — which is where a token has to be rejected — runs on the Edge
 * runtime with no way to reach the bucket, and would pay a network round trip on
 * every request if it could.
 *
 * What exists instead: tokens expire on their own, and rotating `APP_PIN` (or
 * `SESSION_SECRET`) invalidates every session at once. Revoking one device while
 * leaving others signed in is not possible, and will not be until there are real
 * accounts — at which point the session store arrives with them.
 */
