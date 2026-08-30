/**
 * Per-page edit gate.
 *
 * A "locked" page is one whose frontmatter carries a `lock:` object
 * containing a salt and the PBKDF2-SHA256 hash of a passphrase. The
 * lock is a friction mechanism: the editor refuses to mount until
 * the user types the right passphrase. The body is NOT re-encrypted
 * under the page passphrase — the master note-crypto envelope still
 * owns the file at rest.
 *
 * PBKDF2 is the lowest common denominator between the renderer
 * (WebCrypto, no Argon2) and any future Node verification path.
 * 100,000 iterations is the floor in lib/vault/record.ts: cheap
 * enough to verify on every unlock, expensive enough that an
 * attacker reading the frontmatter cannot brute-force a 6-character
 * passphrase without a perceptible delay. The vault record format
 * reserves the right to switch to Argon2id later; this lock object
 * carries its own `kdf` field so the same migration is possible.
 *
 * Two non-obvious decisions:
 *
 *   - The hash is the *derived key bytes*, not `SHA-256(salt + pwd)`.
 *     Deriving costs 100k hashes per attempt and is the same cost an
 *     attacker pays; a plain hash would not.
 *   - The salt is per-page, not per-user. Re-using the same
 *     passphrase on two pages must not produce the same hash.
 */

import { MIN_PBKDF2_ITERATIONS } from '../vault/record'

/** Pin the algorithm name in the on-disk object so a future switch to Argon2id is read-distinguishable. */
const KDF_ALGORITHM = 'PBKDF2-SHA256' as const
const PBKDF2_ITERATIONS = MIN_PBKDF2_ITERATIONS
const SALT_BYTES = 16
const HASH_BYTES = 32

/**
 * The shape persisted under `frontmatter.lock`.
 *
 * `kdf` is kept as a string ("PBKDF2-SHA256") instead of a nested
 * object so the field stays a single line and the YAML is easy to
 * eyeball. The version and iteration count live alongside the
 * algorithm for the same reason a vault record carries them.
 */
export interface PageLock {
  kdf: typeof KDF_ALGORITHM
  salt: string
  iterations: number
  hash: string
}

const encoder = new TextEncoder()

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function deriveHash(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    material,
    HASH_BYTES * 8
  )
  return new Uint8Array(bits)
}

/**
 * Builds a fresh lock object for a new passphrase.
 *
 * Each call gets its own salt; re-locking the same page with the
 * same passphrase must produce a different `lock:` (otherwise the
 * salt is doing nothing).
 */
export async function makeLock(passphrase: string): Promise<PageLock> {
  if (!passphrase) throw new Error('Passphrase must not be empty.')
  const salt = randomBytes(SALT_BYTES)
  const hash = await deriveHash(passphrase, salt, PBKDF2_ITERATIONS)
  return {
    kdf: KDF_ALGORITHM,
    salt: toBase64Url(salt),
    iterations: PBKDF2_ITERATIONS,
    hash: toBase64Url(hash),
  }
}

/**
 * Constant-time check that `passphrase` opens the given `lock`.
 *
 * Both `lock.hash` and the freshly-derived bytes are base64url
 * strings; comparing the decoded bytes is the actual check. The
 * WebCrypto derive call pays the same cost an attacker would, so
 * the gate is no weaker than the storage format it is gating.
 */
export async function verifyPassphrase(passphrase: string, lock: PageLock): Promise<boolean> {
  if (lock.kdf !== KDF_ALGORITHM) return false
  const salt = fromBase64Url(lock.salt)
  const expected = fromBase64Url(lock.hash)
  const actual = await deriveHash(passphrase, salt, lock.iterations)
  if (expected.length !== actual.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0)
  }
  return diff === 0
}

/**
 * Type guard for the lock object, in case it was hand-edited or
 * carried over from an older format.
 */
export function isPageLock(value: unknown): value is PageLock {
  if (!value || typeof value !== 'object') return false
  const lock = value as Record<string, unknown>
  return (
    lock.kdf === KDF_ALGORITHM &&
    typeof lock.salt === 'string' &&
    typeof lock.hash === 'string' &&
    typeof lock.iterations === 'number' &&
    lock.iterations >= MIN_PBKDF2_ITERATIONS
  )
}
