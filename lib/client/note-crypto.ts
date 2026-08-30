'use client'

/**
 * Note body encryption on top of the password-vault key.
 *
 * The vault and the notes share one master password. When the user unlocks the
 * vault, the same `CryptoKey` is published via `VaultKeyContext` and reused
 * here to encrypt and decrypt note bodies. The server only ever sees the
 * ciphertext; the salt + iterations live in the vault record (`/api/vault`).
 *
 * Blob shape on the wire:
 *   `<base64url(nonce)>.<base64url(ciphertext+tag)>`
 *
 * Compact by design — note bodies are bigger than the vault and the JSON
 * envelope the vault uses would multiply bytes. GCM authenticates as it
 * decrypts, so a flipped bit anywhere in the blob fails closed.
 */

const NONCE_BYTES = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value + '==='.slice((value.length + 3) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export class NoteCryptoError extends Error {
  readonly code = 'NOTE_CRYPTO_FAILED'
  constructor(message = 'Could not decrypt this note. The master password may have changed, or the data was tampered with.') {
    super(message)
    this.name = 'NoteCryptoError'
  }
}

export async function encryptBody(plain: string, key: CryptoKey): Promise<string> {
  const nonce = randomBytes(NONCE_BYTES)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    key,
    encoder.encode(plain)
  )
  return toBase64Url(nonce) + '.' + toBase64Url(new Uint8Array(encrypted))
}

export async function decryptBody(blob: string, key: CryptoKey): Promise<string> {
  const dot = blob.indexOf('.')
  if (dot <= 0) throw new NoteCryptoError('Malformed ciphertext')
  const nonce = fromBase64Url(blob.slice(0, dot))
  const ciphertext = fromBase64Url(blob.slice(dot + 1))
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    )
    return decoder.decode(plaintext)
  } catch {
    throw new NoteCryptoError()
  }
}

/**
 * Heuristic: ciphertext produced by `encryptBody` is base64url with one dot.
 * Plaintext is not. Used to decide whether a note read from R2 needs
 * decryption, so an unencrypted corpus (the path the user is on before they
 * set a master password) stays readable.
 */
export function looksLikeCiphertext(blob: string): boolean {
  if (!blob) return false
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(blob)) return false
  return blob.length > 20
}
