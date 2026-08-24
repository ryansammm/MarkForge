import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>

/**
 * Password hashing for protected shares.
 *
 * scrypt rather than a bare SHA: a share password is chosen by a person, typed into
 * a public page, and guarded only by whatever makes guessing expensive. A fast hash
 * would make an offline attack on a leaked `shares.json` trivial, and `shares.json`
 * is a file in a bucket that also holds the backups.
 *
 * Format: `scrypt$<salt base64url>$<key base64url>`. Self-describing, so a future
 * change of parameters can be detected rather than silently mis-verified.
 */

const KEY_LENGTH = 32
const SALT_LENGTH = 16

export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await scryptAsync(password, salt, KEY_LENGTH)
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`
}

/**
 * Verifies a candidate password.
 *
 * Returns false for anything it does not understand — a malformed or truncated hash
 * fails closed, because the alternative is a corrupt record silently unlocking.
 */
export async function verifySharePassword(candidate: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false

  const salt = Buffer.from(parts[1], 'base64url')
  const expected = Buffer.from(parts[2], 'base64url')
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false

  const actual = await scryptAsync(candidate, salt, KEY_LENGTH)
  return timingSafeEqual(actual, expected)
}
