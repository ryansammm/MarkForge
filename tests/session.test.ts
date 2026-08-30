import {
  SESSION_TTL_SECONDS,
  mintSession,
  sessionSecret,
  shouldRenew,
  verifySession,
} from '../lib/session'
import {
  AUTH_LIMIT,
  checkRateLimit,
  clearRateLimit,
  clientKey,
  resetRateLimits,
} from '../lib/server/rate-limit'

/**
 * Session and rate-limit suite (production-readiness plan, Phase 2 — blocker B1).
 *
 * The property that matters most is negative: **a token this module did not sign must
 * not verify.** Everything else — expiry, renewal, limits — is secondary to that,
 * because a forgeable session token is worse than the plaintext-password cookie it
 * replaced. That one at least required knowing the password.
 */

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures.push(`${name}\n      ${(err as Error).message}`)
    console.error(`  FAIL ${name}`)
    console.error(`       ${(err as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

const SECRET = 'test-signing-secret'

export async function runSessionTests(): Promise<boolean> {
  console.log('Session and rate-limit suite (Phase 2)\n')

  console.log('signing and verification')

  await check('a freshly minted token verifies', async () => {
    const token = await mintSession(SECRET)
    const payload = await verifySession(SECRET, token)
    assert(payload, 'a valid token did not verify')
    assert(payload!.sid, 'no session id in the payload')
    equal(payload!.exp - payload!.iat, SESSION_TTL_SECONDS, 'wrong lifetime')
  })

  await check('the token carries no secret', async () => {
    // The whole point. The old cookie value was the gate secret itself.
    const token = await mintSession(SECRET)
    assert(!token.includes(SECRET), 'the signing secret appears in the token')
    const decoded = Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')
    assert(!decoded.includes(SECRET), 'the signing secret appears in the payload')
    assert(!/password/i.test(decoded), 'the payload mentions a password')
  })

  await check('a token signed with another secret is refused', async () => {
    const token = await mintSession('a-different-secret')
    equal(await verifySession(SECRET, token), null, 'a foreign token verified')
  })

  await check('a tampered payload is refused', async () => {
    const token = await mintSession(SECRET)
    const [version, encoded, signature] = token.split('.')

    // Re-encode the payload with a far-future expiry, keeping the original signature.
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'))
    payload.exp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url')

    equal(await verifySession(SECRET, `${version}.${forged}.${signature}`), null, 'a forged expiry verified')
  })

  await check('a tampered signature is refused', async () => {
    const token = await mintSession(SECRET)
    const [version, encoded, signature] = token.split('.')
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A')
    equal(await verifySession(SECRET, `${version}.${encoded}.${flipped}`), null, 'a bad signature verified')
  })

  await check('malformed and empty tokens are refused', async () => {
    for (const token of ['', 'garbage', 'v1.only-two', 'v2.a.b', '...', 'v1..']) {
      equal(await verifySession(SECRET, token), null, `"${token}" verified`)
    }
    equal(await verifySession(SECRET, undefined), null, 'a missing token verified')
  })

  await check('an expired token is refused', async () => {
    const token = await mintSession(SECRET, { ttlSeconds: 60 })
    assert(await verifySession(SECRET, token), 'a live token did not verify')
    equal(await verifySession(SECRET, token, Date.now() + 61_000), null, 'an expired token verified')
  })

  await check('each session gets its own id', async () => {
    const a = await verifySession(SECRET, await mintSession(SECRET))
    const b = await verifySession(SECRET, await mintSession(SECRET))
    assert(a!.sid !== b!.sid, 'two sessions share an id')
  })

  console.log('\nsliding expiry')

  await check('a fresh token is not renewed', async () => {
    const payload = (await verifySession(SECRET, await mintSession(SECRET)))!
    equal(shouldRenew(payload), false, 'a brand new token wanted renewing')
  })

  await check('a token past half its life is renewed', async () => {
    const payload = (await verifySession(SECRET, await mintSession(SECRET)))!
    const later = Date.now() + (SESSION_TTL_SECONDS * 1000 * 3) / 4
    equal(shouldRenew(payload, later), true, 'an aging token was not renewed')
  })

  await check('renewal keeps the session id', async () => {
    const original = (await verifySession(SECRET, await mintSession(SECRET)))!
    const renewed = (await verifySession(SECRET, await mintSession(SECRET, { sid: original.sid })))!
    equal(renewed.sid, original.sid, 'renewing changed the session identity')
    assert(renewed.exp >= original.exp, 'renewing shortened the session')
  })

  console.log('\nthe signing key')

  await check('SESSION_SECRET is preferred when set', () => {
    equal(sessionSecret({ SESSION_SECRET: 'explicit', APP_PIN: '123456' }), 'explicit', 'wrong key chosen')
  })

  await check('the derived key is never the PIN itself', () => {
    const derived = sessionSecret({ APP_PIN: '123456' })
    assert(derived, 'no key derived from a configured PIN')
    assert(derived !== '123456', 'the signing key is the PIN verbatim')
  })

  await check('no PIN and no secret means no gate', () => {
    equal(sessionSecret({}), null, 'a gate was configured out of nothing')
  })

  await check('rotating the PIN invalidates existing sessions', async () => {
    // This is the "sign out everywhere" control, so it needs to actually work.
    const before = sessionSecret({ APP_PIN: '111111' })!
    const token = await mintSession(before)
    const after = sessionSecret({ APP_PIN: '222222' })!
    equal(await verifySession(after, token), null, 'a session survived a PIN rotation')
  })

  console.log('\nrate limiting')

  await check('the sixth attempt in a window is refused', async () => {
    resetRateLimits()
    for (let i = 0; i < AUTH_LIMIT.limit; i++) {
      assert(checkRateLimit('ip:1.2.3.4', AUTH_LIMIT).ok, `attempt ${i + 1} was refused early`)
    }
    const blocked = checkRateLimit('ip:1.2.3.4', AUTH_LIMIT)
    equal(blocked.ok, false, 'unlimited attempts are still allowed')
    assert(blocked.retryAfter > 0, 'no retry hint given')
  })

  await check('the window expires', async () => {
    resetRateLimits()
    const now = Date.now()
    for (let i = 0; i < AUTH_LIMIT.limit; i++) checkRateLimit('ip:5.6.7.8', AUTH_LIMIT, now)
    equal(checkRateLimit('ip:5.6.7.8', AUTH_LIMIT, now).ok, false, 'the limit did not apply')
    equal(
      checkRateLimit('ip:5.6.7.8', AUTH_LIMIT, now + AUTH_LIMIT.windowMs + 1).ok,
      true,
      'the window never reopens'
    )
  })

  await check('clients are limited independently', () => {
    resetRateLimits()
    for (let i = 0; i < AUTH_LIMIT.limit; i++) checkRateLimit('ip:1.1.1.1', AUTH_LIMIT)
    equal(checkRateLimit('ip:1.1.1.1', AUTH_LIMIT).ok, false, 'the first client was not limited')
    equal(checkRateLimit('ip:2.2.2.2', AUTH_LIMIT).ok, true, 'one client blocked another')
  })

  await check('a successful sign-in clears the count', () => {
    // Otherwise five typos over a fortnight lock someone out of their own notes.
    resetRateLimits()
    for (let i = 0; i < AUTH_LIMIT.limit - 1; i++) checkRateLimit('ip:9.9.9.9', AUTH_LIMIT)
    clearRateLimit('ip:9.9.9.9')
    for (let i = 0; i < AUTH_LIMIT.limit; i++) {
      assert(checkRateLimit('ip:9.9.9.9', AUTH_LIMIT).ok, 'the count was not cleared')
    }
  })

  await check('the client key comes from proxy headers', () => {
    const request = new Request('http://localhost/api/auth', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    })
    equal(clientKey(request, 'auth'), 'auth:203.0.113.7', 'wrong client key')
  })

  await check('a request with no forwarding headers still gets a key', () => {
    equal(clientKey(new Request('http://localhost/api/auth'), 'auth'), 'auth:unknown', 'no fallback key')
  })

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

if (require.main === module) {
  runSessionTests().then((ok) => process.exit(ok ? 0 : 1))
}
