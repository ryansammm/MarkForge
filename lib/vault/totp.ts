/**
 * RFC 6238 TOTP — Time-based One-Time Password, the "Authenticator app" code.
 *
 * The secret stays at rest in the vault; the 6-digit code is computed from
 * the current Unix 30-second time slot and the secret. The code is the
 * one thing the caller logs into a site — never persist the code, and
 * `currentCode` is `null` when the secret is malformed so a UI can hide
 * the field rather than show `000000`.
 *
 * HMAC-SHA1 is the RFC 6238 default and what every Authenticator app emits
 * by default; SHA-256 and SHA-512 are options we do not bother with because
 * the secret format from a site is almost always the 160-bit variant.
 *
 * All crypto goes through `crypto.subtle`, which is available in every
 * browser we ship to. There is no node-specific code here so the module
 * can be loaded from a worker if the vault ever needs one.
 */

const PERIOD = 30
const DIGITS = 6

/**
 * Decodes a base32 string (RFC 4648, no padding required) into bytes.
 *
 * TOTP secrets arrive in many shapes: `JBSWY3DPEHPK3PXP`, `JBSW Y3DP EHPK 3PXP`,
 * `jbswy3dpehpk3pxp`, `jbsw y3dp ehpk 3pxp===`. All four are the same secret.
 * Whitespace and case are normalised; the trailing `=` padding is optional.
 */
export function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const cleaned = input.replace(/[\s=]/g, '').toUpperCase()
  if (cleaned.length === 0) return new Uint8Array(0)

  const out = new Uint8Array(Math.floor((cleaned.length * 5) / 8))
  let bits = 0
  let value = 0
  let outIndex = 0
  for (const char of cleaned) {
    const index = alphabet.indexOf(char)
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[outIndex++] = (value >> bits) & 0xff
    }
  }
  return out.slice(0, outIndex)
}

/**
 * The number of whole seconds left in the current 30-second window.
 *
 * Drives the countdown dial in the UI. At `0` the displayed code is about
 * to roll over and a re-render is needed; the code itself is still valid
 * for the rest of the period (RFC 6238 §5.1).
 */
export function secondsRemaining(now: number = Date.now()): number {
  return PERIOD - (Math.floor(now / 1000) % PERIOD)
}

/**
 * Generates the 6-digit code for a given secret at a given time.
 *
 * Returns `null` if the secret does not decode, so a malformed value
 * (e.g. an `otpauth://` URL the user pasted by mistake) shows nothing
 * instead of `000000`. Pass `step` explicitly in tests; the default is
 * the floor of `now/1000 / 30`.
 */
export async function generateCode(
  secret: string,
  now: number = Date.now(),
  { period = PERIOD, digits = DIGITS }: { period?: number; digits?: number } = {}
): Promise<string | null> {
  let key: Uint8Array
  try {
    key = base32Decode(secret)
  } catch {
    return null
  }
  if (key.length === 0) return null

  const step = Math.floor(now / 1000 / period)
  // 8-byte big-endian counter, RFC 6238 §4.
  const counter = new ArrayBuffer(8)
  const view = new DataView(counter)
  view.setUint32(0, Math.floor(step / 0x100000000))
  view.setUint32(4, step >>> 0)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  )
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counter))

  // Dynamic truncation, RFC 6238 §5.3.
  const offset = signature[signature.length - 1] & 0x0f
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff)

  const modulus = 10 ** digits
  return String(binary % modulus).padStart(digits, '0')
}

/**
 * A snapshot suitable for the UI: the current code, formatted with a space
 * in the middle (`123 456`) so it reads as a six-digit number, and the
 * seconds left in the window so the dial can render without recomputing.
 */
export async function currentCode(
  secret: string,
  now: number = Date.now()
): Promise<{ code: string; secondsLeft: number } | null> {
  const code = await generateCode(secret, now)
  if (code === null) return null
  return {
    code: `${code.slice(0, 3)} ${code.slice(3)}`,
    secondsLeft: secondsRemaining(now),
  }
}
