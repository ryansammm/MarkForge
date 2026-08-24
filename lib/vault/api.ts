/**
 * Typed client for `/api/vault`.
 *
 * Separate from lib/workspace-api.ts on purpose. Everything in that module moves
 * documents; everything in this one moves ciphertext, and keeping the two apart means
 * a future helper cannot casually acquire a `path` parameter or start sharing an error
 * path that logs its request body.
 *
 * There is one rule here and it is the whole feature: **the master password is not a
 * parameter of any function in this file.** It never leaves lib/vault/crypto.ts.
 */

import type { PasswordVaultRecord, VaultEnvelope } from './record'

export class VaultApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Present on a 409: the revision the server actually holds. */
    readonly actualRevision?: string | null
  ) {
    super(message)
    this.name = 'VaultApiError'
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init })
  } catch (err) {
    throw new VaultApiError(`Could not reach the server: ${(err as Error).message}`, 0, 'NETWORK')
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      code?: string
      actualRevision?: string | null
    }
    throw new VaultApiError(
      response.status === 401
        ? 'Your session expired — sign in again.'
        : (body.error ?? `Request failed (${response.status})`),
      response.status,
      body.code,
      body.actualRevision
    )
  }

  return (await response.json()) as T
}

/** The stored record, or null when no vault has been created on this workspace. */
export function fetchVault() {
  return request<{ record: PasswordVaultRecord | null }>('/api/vault')
}

/**
 * Stores a new record.
 *
 * `ifMatch` is required by the route, not merely accepted: a save that does not say
 * what it believes the current revision to be is a save that can overwrite a change
 * made in another tab without either side noticing.
 */
export function saveVault(envelope: VaultEnvelope, ifMatch: string) {
  return request<{ revision: string; updatedAt: string }>('/api/vault', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${ifMatch}"` },
    body: JSON.stringify(envelope),
  })
}
