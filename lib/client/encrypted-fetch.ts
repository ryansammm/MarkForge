'use client'

/**
 * Transparent encrypt-on-write / decrypt-on-read for note bodies.
 *
 * The server treats the document body as an opaque string. When the
 * password vault is unlocked, this wrapper encrypts the body before it
 * leaves the browser (`PUT`, `POST /api/files`, `createDocument`) and
 * decrypts on the way back (`GET`). When the vault is locked or absent,
 * the wrapper is a pass-through and notes stay plaintext — that is the
 * "no master password yet" path, and it is what makes the feature opt-in.
 *
 * Other routes (auth, index, share, trash) are not wrapped: the index
 * metadata is plaintext by design, and share/trash go through their own
 * paths.
 */

import * as api from '@/lib/workspace-api'
import { ApiError } from '@/lib/workspace-api'
import { decryptBody, encryptBody, looksLikeCiphertext, NoteCryptoError } from './note-crypto'
import type { MarkdownDocument, WriteResult } from '@/lib/file-store'

export interface EncryptedDocumentResponse {
  document: MarkdownDocument
  raw: string
}

async function withKey<T>(key: CryptoKey | null, run: (key: CryptoKey | null) => Promise<T>): Promise<T> {
  return run(key)
}

export async function readDocument(path: string, key: CryptoKey | null) {
  return withKey(key, async (k) => {
    const response = await api.readDocument(path)
    if (!k) return response
    if (!looksLikeCiphertext(response.raw)) return response
    try {
      const plain = await decryptBody(response.raw, k)
      return { ...response, raw: plain }
    } catch (err) {
      if (err instanceof NoteCryptoError) {
        // Stale key, wrong password, or the note was written before this
        // version of the encryptor. Surface the failure with the path
        // so the user can tell the affected note apart.
        throw new ApiError(`Could not decrypt ${path}: ${err.message}`, 0, 'NOTE_CRYPTO_FAILED')
      }
      throw err
    }
  })
}

export interface WriteInput {
  path: string
  content: string
  ifMatch?: string
}

export async function writeDocument(input: WriteInput, key: CryptoKey | null): Promise<WriteResult> {
  return withKey(key, async (k) => {
    const body = k ? await encryptBody(input.content, k) : input.content
    return api.writeDocument(input.path, body, input.ifMatch)
  })
}

export async function createDocument(path: string, content: string, key: CryptoKey | null): Promise<WriteResult> {
  return withKey(key, async (k) => {
    const body = k ? await encryptBody(content, k) : content
    return api.createDocument(path, body)
  })
}
