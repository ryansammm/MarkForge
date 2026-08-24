/**
 * The wire and storage format of the password vault.
 *
 * This module is the boundary the whole feature rests on: it is imported by the
 * browser, by the API route, and by the store, and it is the one place that decides
 * what a vault record is allowed to contain. Everything a credential actually *is* —
 * site, username, password, note, tag, even how many items there are — lives inside
 * `cipher.ciphertext` and is never a field here.
 *
 * The validation is a strict allowlist rather than a shape check, and that is
 * deliberate. A permissive parser is how plaintext ends up on a server: someone adds
 * `{ ...item, name }` to a debug payload, the record still validates, and the name of
 * every site you have an account with is now in a bucket, a backup, and a log. An
 * unknown key is rejected outright, so that mistake fails at the API boundary instead
 * of succeeding quietly.
 *
 * No crypto here and no Node builtins — the browser imports this too.
 */

/** Metadata name. Not a document key: the corpus keyspace never sees it. */
export const VAULT_FILE = 'password-vault.json'

export const VAULT_VERSION = 1

/**
 * `If-Match` sentinel meaning "there must be no vault yet".
 *
 * Same spelling as `CREATE_ONLY` in lib/file-store.ts, and deliberately its own
 * constant: the vault does not travel through the document write path, and a shared
 * import would be the first thread tying the two together.
 */
export const VAULT_CREATE_ONLY = '*none*'

/**
 * Key derivation parameters, stored in the clear.
 *
 * They have to be: unlocking on a second device means re-deriving the same key from
 * the same salt, and the salt is not a secret — it exists so two vaults with the same
 * master password do not share a key.
 *
 * A union rather than a fixed shape because the KDF is the part most likely to be
 * replaced. v1 writes `PBKDF2-SHA256` (WebCrypto, no dependency — see
 * docs/password-manager-plan.md for why); `argon2id` is described here so a later
 * vault written with it parses, and an old vault can be re-sealed under the new
 * parameters on the next unlock rather than being stranded.
 */
export type VaultKdf =
  | { algorithm: 'PBKDF2-SHA256'; salt: string; iterations: number }
  | { algorithm: 'argon2id'; salt: string; memoryKiB: number; iterations: number; parallelism: number }

export interface VaultCipher {
  algorithm: 'AES-256-GCM' | 'XChaCha20-Poly1305'
  /** Unique per encryption. Reusing one under the same key breaks the cipher. */
  nonce: string
  /** Base64 of the AEAD output: the encrypted vault plus its authentication tag. */
  ciphertext: string
}

/**
 * What the browser sends and what the browser gets back to decrypt.
 *
 * Split from the stored record because `revision` and `updatedAt` are the server's to
 * assign — a client that could choose its own revision could defeat the conflict
 * check that stops one device silently overwriting another.
 */
export interface VaultEnvelope {
  version: typeof VAULT_VERSION
  kdf: VaultKdf
  cipher: VaultCipher
}

export interface PasswordVaultRecord extends VaultEnvelope {
  /** Opaque, server-assigned, changes on every write. The If-Match token. */
  revision: string
  updatedAt: string
}

export class InvalidVaultRecordError extends Error {
  readonly code = 'INVALID_VAULT_RECORD'
  constructor(reason: string) {
    super(`Invalid vault record: ${reason}`)
    this.name = 'InvalidVaultRecordError'
  }
}

/**
 * Bounds on the KDF cost.
 *
 * The floor is the point of the thing — a vault written with 1,000 iterations is a
 * vault that brute-forces in an afternoon, and accepting one would let a tampered
 * record talk the *next* unlock into being cheap. The ceiling is the other direction:
 * derivation runs in the owner's browser, so an absurd iteration count in a record is
 * a way to hang the tab of the one person entitled to open it.
 */
export const MIN_PBKDF2_ITERATIONS = 100_000
export const MAX_PBKDF2_ITERATIONS = 5_000_000

/** Salt and nonce sizes are checked so a truncated record fails here, not at unlock. */
const MIN_SALT_BYTES = 16
const MAX_SALT_BYTES = 64
const MIN_NONCE_BYTES = 12
const MAX_NONCE_BYTES = 24

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function base64Bytes(value: unknown, field: string): number {
  if (typeof value !== 'string' || value.length === 0 || !BASE64.test(value)) {
    throw new InvalidVaultRecordError(`${field} must be base64`)
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

/** Rejects anything the shape does not explicitly name. See the note at the top. */
function allowKeys(value: unknown, allowed: string[], field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidVaultRecordError(`${field} must be an object`)
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new InvalidVaultRecordError(`${field} has an unexpected field`)
    }
  }
  return record
}

function positiveInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidVaultRecordError(`${field} is out of range`)
  }
  return value
}

function parseKdf(value: unknown): VaultKdf {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidVaultRecordError('kdf must be an object')
  }
  const algorithm = (value as { algorithm?: unknown }).algorithm

  if (algorithm === 'PBKDF2-SHA256') {
    const kdf = allowKeys(value, ['algorithm', 'salt', 'iterations'], 'kdf')
    const saltBytes = base64Bytes(kdf.salt, 'kdf.salt')
    if (saltBytes < MIN_SALT_BYTES || saltBytes > MAX_SALT_BYTES) {
      throw new InvalidVaultRecordError('kdf.salt is the wrong length')
    }
    return {
      algorithm,
      salt: kdf.salt as string,
      iterations: positiveInteger(
        kdf.iterations,
        'kdf.iterations',
        MIN_PBKDF2_ITERATIONS,
        MAX_PBKDF2_ITERATIONS
      ),
    }
  }

  if (algorithm === 'argon2id') {
    const kdf = allowKeys(
      value,
      ['algorithm', 'salt', 'memoryKiB', 'iterations', 'parallelism'],
      'kdf'
    )
    const saltBytes = base64Bytes(kdf.salt, 'kdf.salt')
    if (saltBytes < MIN_SALT_BYTES || saltBytes > MAX_SALT_BYTES) {
      throw new InvalidVaultRecordError('kdf.salt is the wrong length')
    }
    return {
      algorithm,
      salt: kdf.salt as string,
      memoryKiB: positiveInteger(kdf.memoryKiB, 'kdf.memoryKiB', 8 * 1024, 1024 * 1024),
      iterations: positiveInteger(kdf.iterations, 'kdf.iterations', 1, 100),
      parallelism: positiveInteger(kdf.parallelism, 'kdf.parallelism', 1, 16),
    }
  }

  throw new InvalidVaultRecordError('unsupported kdf.algorithm')
}

function parseCipher(value: unknown): VaultCipher {
  const cipher = allowKeys(value, ['algorithm', 'nonce', 'ciphertext'], 'cipher')

  if (cipher.algorithm !== 'AES-256-GCM' && cipher.algorithm !== 'XChaCha20-Poly1305') {
    throw new InvalidVaultRecordError('unsupported cipher.algorithm')
  }

  const nonceBytes = base64Bytes(cipher.nonce, 'cipher.nonce')
  if (nonceBytes < MIN_NONCE_BYTES || nonceBytes > MAX_NONCE_BYTES) {
    throw new InvalidVaultRecordError('cipher.nonce is the wrong length')
  }
  base64Bytes(cipher.ciphertext, 'cipher.ciphertext')

  return {
    algorithm: cipher.algorithm,
    nonce: cipher.nonce as string,
    ciphertext: cipher.ciphertext as string,
  }
}

/**
 * Validates what a client sent.
 *
 * Throws on anything it does not recognise, including extra fields — the API route
 * turns that into a 400 with a message that names the field and nothing else.
 */
export function parseVaultEnvelope(value: unknown): VaultEnvelope {
  const envelope = allowKeys(value, ['version', 'kdf', 'cipher'], 'record')

  if (envelope.version !== VAULT_VERSION) {
    throw new InvalidVaultRecordError('unsupported version')
  }

  return {
    version: VAULT_VERSION,
    kdf: parseKdf(envelope.kdf),
    cipher: parseCipher(envelope.cipher),
  }
}

/** Validates a record read back from storage, revision and timestamp included. */
export function parseVaultRecord(value: unknown): PasswordVaultRecord {
  const record = allowKeys(value, ['version', 'kdf', 'cipher', 'revision', 'updatedAt'], 'record')

  if (typeof record.revision !== 'string' || record.revision.length === 0) {
    throw new InvalidVaultRecordError('revision is missing')
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new InvalidVaultRecordError('updatedAt is not a timestamp')
  }

  const envelope = parseVaultEnvelope({
    version: record.version,
    kdf: record.kdf,
    cipher: record.cipher,
  })

  return { ...envelope, revision: record.revision, updatedAt: record.updatedAt }
}
