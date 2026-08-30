/**
 * Self-check for lib/client/note-crypto.ts.
 *
 * The encryptor lives in the browser. Node 22 ships WebCrypto on the
 * global `crypto` and TextEncoder/Decoder, so we can exercise the
 * functions directly without a browser. Run with:
 *   node_modules/.bin/tsx scripts/check-note-crypto.ts
 */
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { decryptBody, encryptBody, looksLikeCiphertext } from '../lib/client/note-crypto'

// Polyfill — the module reaches for `crypto.subtle` and `crypto.getRandomValues`,
// both available on the global `crypto` in Node ≥ 19. Assigning once is enough.
if (!globalThis.crypto) (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto

async function makeKey(): Promise<CryptoKey> {
  return webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  ) as unknown as CryptoKey
}

async function main(): Promise<void> {
  const key = await makeKey()

  // 1. Round-trip
  const plain = '# Hello\n\nThis is a note with **bold** and `code`.\n'
  const blob = await encryptBody(plain, key)
  assert(blob.includes('.'), 'blob has the dot separator')
  const back = await decryptBody(blob, key)
  assert.equal(back, plain, 'round-trip restored the original plaintext')
  console.log(`round-trip ok (${plain.length} chars → ${blob.length} chars)`)

  // 2. Heuristic: ciphertext looks like ciphertext
  assert(looksLikeCiphertext(blob), 'encrypted blob is recognised as ciphertext')

  // 3. Heuristic: plaintext does not
  assert(!looksLikeCiphertext(plain), 'plaintext is not mistaken for ciphertext')
  assert(!looksLikeCiphertext(''), 'empty string is not ciphertext')
  assert(!looksLikeCiphertext('no-dot-here'), 'missing dot is not ciphertext')
  assert(!looksLikeCiphertext('two.dots.here'), 'extra dots are not ciphertext')

  // 4. Tampered ciphertext fails closed
  const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A') + blob.slice(-1)
  await assert.rejects(decryptBody(tampered, key), 'tampered ciphertext must reject')

  // 5. Wrong key fails closed
  const otherKey = await makeKey()
  await assert.rejects(decryptBody(blob, otherKey), 'wrong key must reject')

  // 6. Malformed blob fails with NoteCryptoError
  await assert.rejects(decryptBody('not-a-blob', key), 'malformed blob must reject')
  await assert.rejects(decryptBody('only-left', key), 'blob without dot must reject')

  // 7. Distinct nonces for repeated encrypts of the same plaintext
  const blob2 = await encryptBody(plain, key)
  assert.notEqual(blob, blob2, 'two encrypts of the same plaintext produce different ciphertext')
  console.log('nonces vary between encrypts')

  console.log('OK')
}

main().catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})

