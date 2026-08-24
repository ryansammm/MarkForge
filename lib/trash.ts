/**
 * The trash — shape, key layout, and retention.
 *
 * Client-safe on purpose, and split from the server module for exactly the reason
 * `share.ts` is split from `share-store.ts`: the restore UI needs the entry type and
 * the retention window, and importing those from a module that reaches for `crypto`
 * would drag a Node builtin into the browser bundle.
 *
 * Deleting used to unlink. The confirm dialog was good — it listed a folder's
 * contents before you agreed — but a good confirm dialog is not a recovery story,
 * and "this cannot be undone" was literally true.
 *
 * Trashed documents live in the **metadata namespace**, not the corpus. That is the
 * load-bearing decision: `listKeys` never returns them, so they are invisible to the
 * index, to a full reindex, to search, and to share-scope resolution — while still
 * being bytes in the same bucket, covered by the same backups. A trash that lived in
 * the document keyspace would need every one of those readers to remember to exclude
 * it, and the first one that forgot would publish a deleted file.
 *
 *   .trash/<entryId>/entry.json          the manifest
 *   .trash/<entryId>/files/<original>    the bytes, at their original paths
 */

export const TRASH_PREFIX = '.trash/'

/** How long a trashed entry survives before `purgeTrash` will remove it. */
export const TRASH_RETENTION_DAYS = 30

export interface TrashEntry {
  id: string
  /** Whether one document or a whole folder was deleted. */
  kind: 'document' | 'folder'
  /** The path that was deleted — a document key, or a folder prefix. */
  path: string
  /** Display name, for the restore list. */
  label: string
  deletedAt: string
  /** Every document path captured in this entry. */
  files: string[]
}

export function entryManifestKey(id: string): string {
  return `${TRASH_PREFIX}${id}/entry.json`
}

export function entryFileKey(id: string, documentPath: string): string {
  return `${TRASH_PREFIX}${id}/files/${documentPath}`
}

/** The id and document path a trash key belongs to, or null if it is not one. */
export function parseEntryFileKey(key: string): { id: string; path: string } | null {
  if (!key.startsWith(TRASH_PREFIX)) return null
  const rest = key.slice(TRASH_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  const id = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  if (!tail.startsWith('files/')) return null
  return { id, path: tail.slice('files/'.length) }
}

export function isExpired(entry: TrashEntry, now: number, retentionDays = TRASH_RETENTION_DAYS): boolean {
  const deleted = Date.parse(entry.deletedAt)
  // An unparseable timestamp is treated as expired rather than immortal: the
  // alternative is an entry nothing can ever clear.
  if (Number.isNaN(deleted)) return true
  return now - deleted > retentionDays * 24 * 60 * 60 * 1000
}
