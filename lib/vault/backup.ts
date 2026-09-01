/**
 * Encrypted vault backup — export to a file the user keeps, import from one
 * they brought back. Self-contained, browser-only, WebCrypto.
 *
 * The file the user downloads is a JSON object of the same shape as the
 * envelope the cloud already stores: `{ version, kdf, cipher, app, exportedAt }`.
 * The only difference is a fresh KDF derived from a *separate* passphrase the
 * user types at export time. That separation is the entire point: the cloud
 * credential (which the server can read) does not double as the
 * offline-archive credential (which the user keeps on a USB drive).
 *
 * Import is the same operation in reverse — open with the backup passphrase,
 * verify the result is a valid `VaultData`, hand it back. The caller decides
 * what "hand it back" means: replace the in-memory vault, write to the cloud,
 * or both. This module does not write; it only seals and unseals.
 *
 * The file format is versioned so an older app can read a newer backup or
 * detect one it should not. `BACKUP_VERSION` bumps on any wire change.
 */

import {
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  MIN_VAULT_MASTER_LENGTH,
  VAULT_VERSION,
  type VaultCipher,
  type VaultEnvelope,
  type VaultKdf,
} from './record'
import { deriveKey, seal, unseal } from './crypto'
import { normalizeVaultData, type VaultData } from './items'

export const BACKUP_VERSION = 1
/** A separate passphrase floor: 8 chars for the daily vault is right, but a
 *  one-time export passphrase is the only thing standing between an attacker
 *  with the file and the contents, so it deserves a higher bar. */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export class BackupPassphraseTooShortError extends Error {
  readonly code = 'BACKUP_PASSPHRASE_TOO_SHORT'
  constructor(length: number) {
    super(
      `Backup passphrase must be at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters (got ${length}).`
    )
    this.name = 'BackupPassphraseTooShortError'
  }
}

export class InvalidBackupFileError extends Error {
  readonly code = 'INVALID_BACKUP_FILE'
  constructor(reason: string) {
    super(`Invalid backup file: ${reason}`)
    this.name = 'InvalidBackupFileError'
  }
}

export interface BackupFile {
  /** Tag identifying this as a MarkForge backup. Bumped on wire change. */
  backupVersion: typeof BACKUP_VERSION
  /** Mirror of the inner envelope version, so the same file works in older
   *  builds that pin VAULT_VERSION but do not know the new shape. */
  version: typeof VAULT_VERSION
  kdf: VaultKdf
  cipher: VaultCipher
  /** UI hint: app name + schema version, not parsed. */
  app: { name: 'MarkForge'; schemaVersion: 1 }
  /** ISO timestamp of when the file was written. Pure metadata. */
  exportedAt: string
  /** Free-form note typed by the user, stored in the clear. Empty string
   *  rather than absent so the field is part of the schema and a reader
   *  always knows the position. */
  note: string
}

const ALLOWED_KEYS = [
  'backupVersion',
  'version',
  'kdf',
  'cipher',
  'app',
  'exportedAt',
  'note',
] as const

function isValidApp(value: unknown): value is BackupFile['app'] {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return obj.name === 'MarkForge' && obj.schemaVersion === 1
}

function isValidKdf(value: unknown): value is VaultKdf {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (obj.algorithm === 'PBKDF2-SHA256') {
    return (
      typeof obj.salt === 'string' &&
      obj.salt.length > 0 &&
      typeof obj.iterations === 'number' &&
      obj.iterations >= MIN_PBKDF2_ITERATIONS &&
      obj.iterations <= MAX_PBKDF2_ITERATIONS
    )
  }
  return false
}

function isValidCipher(value: unknown): value is VaultCipher {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    obj.algorithm === 'AES-256-GCM' &&
    typeof obj.nonce === 'string' &&
    obj.nonce.length > 0 &&
    typeof obj.ciphertext === 'string' &&
    obj.ciphertext.length > 0
  )
}

function parseBackupFile(value: unknown): BackupFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidBackupFileError('not an object')
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new InvalidBackupFileError(`unexpected field: ${key}`)
    }
  }
  if (obj.backupVersion !== BACKUP_VERSION) {
    throw new InvalidBackupFileError(`unsupported backupVersion: ${obj.backupVersion}`)
  }
  if (obj.version !== VAULT_VERSION) {
    throw new InvalidBackupFileError(`unsupported vault version: ${obj.version}`)
  }
  if (!isValidKdf(obj.kdf)) {
    throw new InvalidBackupFileError('kdf is invalid')
  }
  if (!isValidCipher(obj.cipher)) {
    throw new InvalidBackupFileError('cipher is invalid')
  }
  if (!isValidApp(obj.app)) {
    throw new InvalidBackupFileError('app is invalid')
  }
  if (typeof obj.exportedAt !== 'string' || Number.isNaN(Date.parse(obj.exportedAt))) {
    throw new InvalidBackupFileError('exportedAt is not a timestamp')
  }
  if (typeof obj.note !== 'string') {
    throw new InvalidBackupFileError('note must be a string')
  }
  return {
    backupVersion: BACKUP_VERSION,
    version: VAULT_VERSION,
    kdf: obj.kdf,
    cipher: obj.cipher,
    app: { name: 'MarkForge', schemaVersion: 1 },
    exportedAt: obj.exportedAt,
    note: obj.note,
  }
}

/** Salt is bigger than the vault salt: a backup passphrase is shorter-lived
 *  but weaker (people write them on paper), so a 24-byte salt gives an
 *  attacker slightly more to grind against. Marginal but cheap. */
const BACKUP_SALT_BYTES = 24
/** 100k iterations: the backup is encrypted on a button click, and a user
 *  waiting longer than a second for the file to start downloading stops
 *  taking backups. The vault record carries the KDF, so this can be
 *  raised later if the cost becomes acceptable. */
const BACKUP_PBKDF2_ITERATIONS = 100_000
// ponytail: lower iteration count than the vault (600k), see doc above for
// the tradeoff. Raise to 600k if PBKDF2 ever moves off the main thread.

export interface ExportOptions {
  passphrase: string
  /** User-typed note, stored verbatim. Empty string if none. */
  note?: string
  /** Override iteration count for tests only. The floor is enforced. */
  iterations?: number
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new BackupPassphraseTooShortError(passphrase.length)
  }
}

/**
 * Encrypts the vault under a fresh key derived from `passphrase`. Returns a
 * self-describing JSON object the caller can stringify, `Blob` and download.
 *
 * Nothing leaves the browser. The envelope the cloud holds and the file the
 * user downloads are siblings, not the same object — the cloud key never
 * touches this module.
 */
export async function exportBackup(data: VaultData, options: ExportOptions): Promise<BackupFile> {
  assertPassphrase(options.passphrase)
  const salt = randomBytes(BACKUP_SALT_BYTES)
  const kdf: VaultKdf = {
    algorithm: 'PBKDF2-SHA256',
    salt: toBase64(salt),
    iterations: Math.max(
      MIN_PBKDF2_ITERATIONS,
      options.iterations ?? BACKUP_PBKDF2_ITERATIONS
    ),
  }
  const key = await deriveKey(options.passphrase, kdf)
  const cipher = await seal(key, data)
  return {
    backupVersion: BACKUP_VERSION,
    version: VAULT_VERSION,
    kdf,
    cipher,
    app: { name: 'MarkForge', schemaVersion: 1 },
    exportedAt: new Date().toISOString(),
    note: options.note ?? '',
  }
}

export interface ImportResult {
  data: VaultData
  file: BackupFile
}

/**
 * Decrypts a backup file. Throws `InvalidBackupFileError` on shape, on
 * unknown versions, and on bad base64; throws `VaultUnlockError` on a
 * wrong passphrase (or a flipped bit, deliberately — see the matching note
 * in `crypto.ts`).
 */
export async function importBackup(value: unknown, passphrase: string): Promise<ImportResult> {
  const file = parseBackupFile(value)
  // deriveKey enforces the passphrase length on its own, but a backup
  // passphrase shorter than the vault master is a misconfig worth naming.
  if (passphrase.length < MIN_VAULT_MASTER_LENGTH) {
    throw new BackupPassphraseTooShortError(passphrase.length)
  }
  const key = await deriveKey(passphrase, file.kdf)
  const envelope: VaultEnvelope = { version: file.version, kdf: file.kdf, cipher: file.cipher }
  const data = await unseal<VaultData>(key, envelope.cipher)
  return { data: normalizeVaultData(data), file }
}

/** Convenience: turn a `BackupFile` into a downloadable `Blob`. */
export function backupToBlob(file: BackupFile): Blob {
  return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
}

/**
 * Convenience: turn a downloaded `File` (from `<input type="file">`) into
 * the parsed object. Throws `InvalidBackupFileError` if the file is not
 * JSON, or if JSON.parse fails.
 */
export async function readBackupFile(file: File): Promise<unknown> {
  const text = await file.text()
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new InvalidBackupFileError(
      `could not be parsed as JSON: ${(err as Error).message}`
    )
  }
}

/** A filename that sorts by date and clearly identifies the file. */
export function suggestedBackupFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19)
  return `markforge-vault-backup-${stamp}.json`
}

// ponytail: kept `toBase64`/`fromBase64` private; crypto.ts owns the same
// helpers but re-exporting them risks accidental use against a non-backup
// envelope, which would be a category bug the type system would not catch.
