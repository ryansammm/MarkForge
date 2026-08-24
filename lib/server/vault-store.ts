import { randomBytes } from 'crypto'
import {
  InvalidVaultRecordError,
  VAULT_CREATE_ONLY,
  VAULT_FILE,
  parseVaultRecord,
  type PasswordVaultRecord,
  type VaultEnvelope,
} from '../vault/record'
import { getStore } from './store'
import type { WorkspaceStore } from './workspace-store'

/**
 * Storage for the encrypted vault.
 *
 * **This class cannot read the vault and must never learn how.** It moves one opaque
 * blob and enforces one rule — that two devices cannot silently overwrite each other.
 * Everything else about a credential happens in a browser.
 *
 * It lives in the metadata namespace, beside `shares.json` and the trash, which buys
 * the isolation the whole feature depends on for free: `listKeys` returns the corpus
 * and nothing else, so the vault is invisible to the index, to a reindex, to search,
 * to share-scope resolution, and to `/api/files` — none of which can address a
 * metadata name at all. tests/vault.test.ts asserts each of those rather than
 * trusting the arrangement.
 */

/** A vault well past any plausible size. A record over this is not a vault. */
export const MAX_VAULT_BYTES = 512 * 1024

/**
 * Raised when the stored record is not a vault record.
 *
 * Deliberately **not** treated as "there is no vault". If a damaged record read as
 * absent, the app would offer to create a fresh one and the first save would destroy
 * whatever was recoverable — turning a restore-from-backup into permanent loss.
 */
export class VaultCorruptError extends Error {
  readonly code = 'VAULT_CORRUPT'
  constructor() {
    super('The stored vault record is unreadable. Restore it from a backup before saving.')
    this.name = 'VaultCorruptError'
  }
}

/**
 * Raised when the caller's revision is not the stored one.
 *
 * Carries the current revision so the client can refetch and merge. It carries no
 * ciphertext: a conflict response is the wrong place to hand out the vault.
 */
export class VaultConflictError extends Error {
  readonly code = 'VAULT_CONFLICT'
  constructor(
    message: string,
    readonly actualRevision: string | null
  ) {
    super(message)
    this.name = 'VaultConflictError'
  }
}

export { VAULT_CREATE_ONLY }

/**
 * Revisions are random, not derived from the content.
 *
 * A content hash would collide whenever two writes produced identical ciphertext,
 * which for a vault is not exotic — save, undo, save again. Colliding revisions make a
 * stale write look current, which is the one failure this exists to prevent. Random
 * also leaks nothing: a hash of the record is a hash of somebody's credentials.
 */
function newRevision(): string {
  return randomBytes(16).toString('base64url')
}

export class VaultStore {
  /** Serializes writes in this process; `writeMetaIfUnchanged` covers the rest. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly files: WorkspaceStore = getStore()) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private parse(raw: string | null): PasswordVaultRecord | null {
    if (raw === null) return null
    try {
      return parseVaultRecord(JSON.parse(raw))
    } catch {
      throw new VaultCorruptError()
    }
  }

  /** The stored record, or null when no vault has been created. */
  async read(): Promise<PasswordVaultRecord | null> {
    return this.parse(await this.files.bucket.readMeta(VAULT_FILE))
  }

  /**
   * Replaces the record, refusing anything but an exact revision match.
   *
   * There is no unconditional write. Every caller states what it believes the current
   * revision to be — `VAULT_CREATE_ONLY` for a vault that should not exist yet — so a
   * second tab with an older copy is refused instead of quietly winning. Losing one
   * credential to a silent overwrite is indistinguishable from never having saved it.
   */
  async write(envelope: VaultEnvelope, options: { ifMatch: string }): Promise<PasswordVaultRecord> {
    const body = (record: PasswordVaultRecord) => JSON.stringify(record, null, 2)

    return this.run(async () => {
      const raw = await this.files.bucket.readMeta(VAULT_FILE)

      if (options.ifMatch === VAULT_CREATE_ONLY) {
        if (raw !== null) {
          // Parsed only to report the revision; a corrupt record still refuses here,
          // which is what stops a bootstrap from overwriting a damaged vault.
          const current = this.parse(raw)
          throw new VaultConflictError('A vault already exists.', current?.revision ?? null)
        }
      } else {
        const current = this.parse(raw)
        if (!current) {
          throw new VaultConflictError('The vault no longer exists.', null)
        }
        if (current.revision !== options.ifMatch) {
          throw new VaultConflictError(
            'The vault changed somewhere else since it was loaded.',
            current.revision
          )
        }
      }

      const record: PasswordVaultRecord = {
        ...envelope,
        revision: newRevision(),
        updatedAt: new Date().toISOString(),
      }

      const serialized = body(record)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_VAULT_BYTES) {
        throw new InvalidVaultRecordError('the record is too large')
      }

      // Compare-and-set against the exact bytes just read. The revision check above
      // covers the honest race; this covers the one where another instance wrote
      // between the two operations, which the revision alone cannot see.
      if (!(await this.files.bucket.writeMetaIfUnchanged(VAULT_FILE, serialized, raw))) {
        const current = await this.read().catch(() => null)
        throw new VaultConflictError(
          'The vault changed somewhere else while this was being saved.',
          current?.revision ?? null
        )
      }

      return record
    })
  }
}

let shared: VaultStore | null = null

export function getVaultStore(): VaultStore {
  if (!shared) shared = new VaultStore()
  return shared
}

/** Test seam — lets a suite point the store at a temp workspace. */
export function resetVaultStore(store: VaultStore | null = null): void {
  shared = store
}
