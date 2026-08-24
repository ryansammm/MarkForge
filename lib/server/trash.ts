import { randomBytes } from 'crypto'

/**
 * Server-side trash helpers.
 *
 * Everything the client also needs — the entry shape, the key layout, the retention
 * window — lives in `lib/trash.ts` and is re-exported here so server code has one
 * import. Only id generation is here, because it is the only part that needs `crypto`.
 */

export * from '../trash'

/**
 * Entry ids are sortable and filesystem-safe.
 *
 * Not an ISO timestamp: those contain colons, which are legal object-storage keys and
 * illegal Windows filenames, and this same string becomes a directory name under the
 * filesystem backend — so a colon here would break deleting entirely on one backend
 * and nowhere else.
 */
export function newTrashId(now: number = Date.now()): string {
  return `${now.toString(36).padStart(9, '0')}-${randomBytes(3).toString('hex')}`
}
