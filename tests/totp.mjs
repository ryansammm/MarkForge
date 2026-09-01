/**
 * Self-check for lib/vault/totp.ts. Asserts the base32 decoder and the
 * RFC 6238 code generation for one well-known test vector. The vector
 * comes from RFC 6238 appendix B (the "12345678901234567890" / "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
 * example, which is also the only test value that does not require a
 * truncated HMAC to be back-computed by hand).
 *
 * Usage:  node --experimental-stm-modules tests/totp.mjs
 *   from the project root.
 */

import { base32Decode, generateCode, currentCode } from '../lib/vault/totp.ts'

// RFC 6238 test vector, using SHA-1 for parity with the spec.
const seed = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
assert(seed.length === 20, 'seed is 20 bytes (SHA-1 block)')

// Pin "now" to a known time, then verify a generated code. The vector
// uses T0=0, period=30, digits=8 — we accept either the 6- or 8-digit
// truncation, since both are valid RFC 6238 outputs and the spec only
// requires the algorithm.
const t = 59 * 1000 // 59 seconds, the canonical first test value
const code = await generateCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', new Date(t), { digits: 8 })
// RFC 6238: at t=59, SHA-1, secret ASCII("12345678901234567890"),
//   digits=8 → "94287082". See appendix B.
assert(code === '94287082', `code at t=59s is 94287082 (got ${code})`)

// And one for 6-digit truncation, the production default.
const code6 = await currentCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', new Date(t))
assert(code6 !== null, '6-digit code is non-null')
assert(/^\d{3} \d{3}$/.test(code6.code), '6-digit code is grouped as "NNN NNN"')
assert(code6.secondsLeft >= 0 && code6.secondsLeft < 30, 'secondsLeft is in [0,30)')

// Malformed secret → null, no throw.
const bad = await currentCode('not-base32!!!', new Date(t))
assert(bad === null, 'malformed secret yields null')

console.log('totp self-check: PASS')

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}
