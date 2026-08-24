/**
 * Vault cryptography. Runs in the browser, and only in the browser.
 *
 * **Nothing here is invented.** Key derivation is PBKDF2-HMAC-SHA256 and encryption is
 * AES-256-GCM, both from WebCrypto — native, audited, shipped by the browser, and
 * worth zero bytes of bundle. The plan named Argon2id, which is the better KDF and is
 * still the intended destination; what it costs today is a WASM dependency in the
 * client bundle of an app that has none, on a blocker the plan itself left open. The
 * record format carries its KDF parameters (lib/vault/record.ts), so a vault written
 * now can be re-sealed under Argon2id on a later unlock without a migration script.
 * That seam is the reason it is safe to ship the boring option first.
 *
 * Two properties matter more than the algorithm choice:
 *
 *   - The derived key is created with `extractable: false`. It exists as a handle the
 *     browser will use and will not export, so no code — including code injected into
 *     this page — can read the key material out of it.
 *   - The master password is a string argument and nothing else. It is never stored,
 *     never sent, never put in a request body, a URL, `localStorage`, or a log.
 *
 * 600,000 iterations is the current OWASP figure for PBKDF2-HMAC-SHA256. It costs a
 * few hundred milliseconds on a phone, which is the point: that cost is paid once by
 * the owner at unlock and once per guess by anyone attacking a stolen record.
 */

import {
  MIN_PBKDF2_ITERATIONS,
  VAULT_VERSION,
  type PasswordVaultRecord,
  type VaultCipher,
  type VaultEnvelope,
  type VaultKdf,
} from './record'

export const PBKDF2_ITERATIONS = 600_000

const SALT_BYTES = 16
/** 96 bits, the size AES-GCM is specified for. Random per encryption, never reused. */
const NONCE_BYTES = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Raised when a vault will not open.
 *
 * One error for every cause — wrong password, flipped bit, truncated ciphertext,
 * swapped record — because they are the same event to a user and distinguishing them
 * tells an attacker holding a modified record whether their modification survived.
 */
export class VaultUnlockError extends Error {
  readonly code = 'VAULT_UNLOCK_FAILED'
  constructor(message = 'That master password did not open the vault.') {
    super(message)
    this.name = 'VaultUnlockError'
  }
}

export class UnsupportedVaultError extends Error {
  readonly code = 'VAULT_UNSUPPORTED'
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedVaultError'
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

/**
 * Fresh KDF parameters for a vault being created.
 *
 * `iterations` is overridable so tests are not forced to pay 600,000 rounds per
 * assertion; the floor in record.ts is what stops that seam becoming a weak vault.
 */
export function newKdfParams(options: { iterations?: number } = {}): VaultKdf {
  return {
    algorithm: 'PBKDF2-SHA256',
    salt: toBase64(randomBytes(SALT_BYTES)),
    iterations: Math.max(MIN_PBKDF2_ITERATIONS, options.iterations ?? PBKDF2_ITERATIONS),
  }
}

/**
 * Derives the vault key from a master password.
 *
 * Non-extractable, so the key material cannot be read back out of the handle this
 * returns — not by this module, and not by anything that manages to run on the page.
 */
export async function deriveKey(masterPassword: string, kdf: VaultKdf): Promise<CryptoKey> {
  if (kdf.algorithm !== 'PBKDF2-SHA256') {
    throw new UnsupportedVaultError(
      `This vault uses ${kdf.algorithm}, which this version of Morrow cannot open. Update the app.`
    )
  }

  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(masterPassword),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(kdf.salt) as unknown as BufferSource,
      iterations: kdf.iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Encrypts the plaintext vault under a fresh nonce. */
export async function seal(key: CryptoKey, data: unknown): Promise<VaultCipher> {
  const nonce = randomBytes(NONCE_BYTES)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    key,
    encoder.encode(JSON.stringify(data))
  )

  return {
    algorithm: 'AES-256-GCM',
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  }
}

/**
 * Decrypts, or throws `VaultUnlockError`.
 *
 * GCM authenticates as well as encrypts, so a record edited anywhere — in the bucket,
 * in a backup, in transit — fails here rather than decrypting to something plausible.
 * That is the property that makes it safe for the server to hold this blob without
 * being trusted with it.
 */
export async function unseal<T>(key: CryptoKey, cipher: VaultCipher): Promise<T> {
  if (cipher.algorithm !== 'AES-256-GCM') {
    throw new UnsupportedVaultError(
      `This vault uses ${cipher.algorithm}, which this version of Morrow cannot open. Update the app.`
    )
  }

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(cipher.nonce) as unknown as BufferSource },
      key,
      fromBase64(cipher.ciphertext) as unknown as BufferSource
    )
  } catch {
    throw new VaultUnlockError()
  }

  try {
    return JSON.parse(decoder.decode(plaintext)) as T
  } catch {
    // Authenticated but not parseable: the key was right and the plaintext is not a
    // vault. Same message — the user's next move is identical either way.
    throw new VaultUnlockError('The vault opened but its contents are unreadable.')
  }
}

/** Everything a bootstrap needs: new salt, derived key, and the first sealed record. */
export async function createEnvelope(
  masterPassword: string,
  data: unknown,
  options: { iterations?: number } = {}
): Promise<{ key: CryptoKey; kdf: VaultKdf; envelope: VaultEnvelope }> {
  const kdf = newKdfParams(options)
  const key = await deriveKey(masterPassword, kdf)
  return { key, kdf, envelope: { version: VAULT_VERSION, kdf, cipher: await seal(key, data) } }
}

/** Re-seals an already-open vault under the same key and salt, with a new nonce. */
export async function resealEnvelope(
  key: CryptoKey,
  kdf: VaultKdf,
  data: unknown
): Promise<VaultEnvelope> {
  return { version: VAULT_VERSION, kdf, cipher: await seal(key, data) }
}

/** Opens a stored record with a master password. */
export async function openRecord<T>(
  record: PasswordVaultRecord,
  masterPassword: string
): Promise<{ key: CryptoKey; data: T }> {
  const key = await deriveKey(masterPassword, record.kdf)
  return { key, data: await unseal<T>(key, record.cipher) }
}
