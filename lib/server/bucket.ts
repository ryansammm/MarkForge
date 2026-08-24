/**
 * The storage primitive the workspace sits on.
 *
 * There is exactly one implementation of the interesting logic — etags, If-Match
 * preconditions, incremental index patching, path containment — and it lives in
 * workspace-store.ts. Backends only move bytes. That split exists because two
 * parallel stores would drift, and the first thing to break when they drift is the
 * claim this whole project rests on: that the index is disposable and a rebuild
 * agrees with a sequence of edits.
 *
 * Consequence worth stating: the same test suite runs against every backend.
 */

/** A stored byte sequence and the type it should be served as. */
export interface BinaryObject {
  bytes: Uint8Array
  contentType: string
}

export interface Bucket {
  /** A human name for the backend, for logs and the health endpoint. */
  readonly kind: string

  // --- documents ------------------------------------------------------------

  /** Document text, or null when the key does not exist. */
  readText(key: string): Promise<string | null>
  writeText(key: string, body: string): Promise<void>
  deleteObject(key: string): Promise<void>
  objectExists(key: string): Promise<boolean>

  /** Every document key, optionally limited to those under `prefix`. */
  listKeys(prefix?: string): Promise<string[]>

  // --- binary objects -------------------------------------------------------
  //
  // Images, in the same keyspace as the documents, because that is where a vault
  // keeps them (lib/server/assets.ts explains why). These are additive: nothing
  // above changes, and a backend that gains them does not read or write a single
  // document byte differently.
  //
  // `listKeys` still means "the corpus" — it filters to `.md` on every real
  // backend — so an image is not a document anywhere in this system. Enumerating
  // images is a separate question with a separate method, and the only caller that
  // should ever ask it passes the asset prefix.
  //
  // Removal and existence are not duplicated here: `deleteObject` and
  // `objectExists` are already keyed on the same keyspace and work unchanged.

  readBinary(key: string): Promise<BinaryObject | null>
  writeBinary(key: string, bytes: Uint8Array, contentType: string): Promise<void>

  /** Every non-document object under `prefix`. Folder markers are not included. */
  listBinaryKeys(prefix?: string): Promise<string[]>

  /**
   * Size and last-modified time for an object, or null when it does not exist.
   *
   * Added for the asset GC, and load-bearing there rather than decorative: an image
   * uploaded thirty seconds ago and not yet saved into a document is indistinguishable
   * from one abandoned last year, unless something can say how old it is. Without this
   * a sweep could delete work that was still being written.
   */
  statObject(key: string): Promise<{ size: number; modifiedAt: string } | null>

  // --- folders --------------------------------------------------------------
  //
  // Object storage has no directories, only a flat keyspace. Sprint 4 made empty
  // folders first-class, so a backend without real directories has to record them
  // some other way. That is the backend's problem, not the store's.

  createFolder(prefix: string): Promise<void>
  /** Recursive: removes the folder and every object beneath it. */
  deleteFolder(prefix: string): Promise<void>
  folderExists(prefix: string): Promise<boolean>
  /** Every known folder, including empty ones. */
  listFolders(): Promise<string[]>

  // --- metadata -------------------------------------------------------------
  //
  // index.json, shares.json, and trashed documents. Everything the app stores
  // that is not part of the corpus lives here, kept out of the document keyspace
  // so a reindex never mistakes it for a note and `listKeys` stays exactly "the
  // corpus". That property is what makes the trash safe: a deleted document is
  // still bytes in the bucket, but it is invisible to the index, to search, and
  // to share-scope resolution, because none of them can see this namespace.

  readMeta(name: string): Promise<string | null>
  writeMeta(name: string, body: string): Promise<void>
  /** Metadata names under a prefix. Used to enumerate the trash. */
  listMeta(prefix: string): Promise<string[]>
  deleteMeta(name: string): Promise<void>

  /**
   * Compare-and-set. Writes only if the stored body is still `expected`, where
   * null means "must not exist yet". Returns false when it has moved on.
   *
   * This is what makes concurrent index updates safe across instances. The store
   * serializes its own writes, but that queue is per-process, and on serverless
   * there are many processes: two of them can each read index.json, patch a
   * different document in, and write, and the second silently drops the first.
   * The document bytes survive either way, so the damage is invisible until a
   * reindex quietly puts back an entry nobody noticed was missing.
   */
  writeMetaIfUnchanged(name: string, body: string, expected: string | null): Promise<boolean>
}

/**
 * In-memory bucket, for tests.
 *
 * Not a toy: the whole store suite runs against this as well as against the real
 * backends, which is what makes "the backends behave identically" a tested claim
 * rather than an intention.
 */
/** Stand-in for an object written before write times were recorded. */
const EPOCH = new Date(0).toISOString()

export class MemoryBucket implements Bucket {
  readonly kind = 'memory'

  private objects = new Map<string, string>()
  private binaries = new Map<string, BinaryObject>()
  private folders = new Set<string>()
  private meta = new Map<string, string>()
  /** Write times, so `statObject` can answer the same question a real backend does. */
  private written = new Map<string, string>()

  async readText(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null
  }

  async writeText(key: string, body: string): Promise<void> {
    this.objects.set(key, body)
    this.written.set(key, new Date().toISOString())
    this.rememberAncestors(key)
  }

  async readBinary(key: string): Promise<BinaryObject | null> {
    const stored = this.binaries.get(key)
    // Copied out, so a caller mutating the array it was handed cannot reach back
    // into storage. The real backends return fresh buffers per read; this one has
    // to be made to behave the same or the conformance suite proves nothing.
    return stored ? { bytes: Uint8Array.from(stored.bytes), contentType: stored.contentType } : null
  }

  async writeBinary(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.binaries.set(key, { bytes: Uint8Array.from(bytes), contentType })
    this.written.set(key, new Date().toISOString())
    // Registered exactly as a text write does. The real backends cannot avoid
    // reporting an asset's directory from listFolders — a filesystem has it, and R2
    // derives folders from key segments — so this one must not avoid it either, or
    // the store's filtering of the asset namespace would be tested against the only
    // backend where the problem does not exist.
    this.rememberAncestors(key)
  }

  async listBinaryKeys(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.binaries.keys())
    if (!prefix) return keys.sort()
    const base = prefix.replace(/\/+$/, '')
    return keys.filter((k) => k === base || k.startsWith(`${base}/`)).sort()
  }

  async statObject(key: string): Promise<{ size: number; modifiedAt: string } | null> {
    const binary = this.binaries.get(key)
    if (binary) {
      return { size: binary.bytes.byteLength, modifiedAt: this.written.get(key) ?? EPOCH }
    }

    const text = this.objects.get(key)
    if (text === undefined) return null
    return { size: Buffer.byteLength(text, 'utf8'), modifiedAt: this.written.get(key) ?? EPOCH }
  }

  /** Test seam: back-date an object so age-dependent behaviour is testable. */
  setModifiedAt(key: string, modifiedAt: string): void {
    this.written.set(key, modifiedAt)
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key)
    this.binaries.delete(key)
    this.written.delete(key)
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key) || this.binaries.has(key)
  }

  /** Writing a/b/c.md implies a and a/b exist, exactly as mkdir -p would. */
  private rememberAncestors(key: string): void {
    const segments = key.split('/')
    segments.pop()
    let walked = ''
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment
      this.folders.add(walked)
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.objects.keys())
    if (!prefix) return keys.sort()
    const base = prefix.replace(/\/+$/, '')
    return keys.filter((k) => k === base || k.startsWith(`${base}/`)).sort()
  }

  async createFolder(prefix: string): Promise<void> {
    const segments = prefix.split('/').filter(Boolean)
    let walked = ''
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment
      this.folders.add(walked)
    }
  }

  async deleteFolder(prefix: string): Promise<void> {
    const base = prefix.replace(/\/+$/, '')
    for (const key of Array.from(this.objects.keys())) {
      if (key === base || key.startsWith(`${base}/`)) this.objects.delete(key)
    }
    for (const key of Array.from(this.binaries.keys())) {
      if (key === base || key.startsWith(`${base}/`)) this.binaries.delete(key)
    }
    for (const folder of Array.from(this.folders)) {
      if (folder === base || folder.startsWith(`${base}/`)) this.folders.delete(folder)
    }
  }

  async folderExists(prefix: string): Promise<boolean> {
    return this.folders.has(prefix.replace(/\/+$/, ''))
  }

  async listFolders(): Promise<string[]> {
    return Array.from(this.folders).sort()
  }

  async readMeta(name: string): Promise<string | null> {
    return this.meta.get(name) ?? null
  }

  async writeMeta(name: string, body: string): Promise<void> {
    this.meta.set(name, body)
  }

  async listMeta(prefix: string): Promise<string[]> {
    return Array.from(this.meta.keys())
      .filter((name) => name.startsWith(prefix))
      .sort()
  }

  async deleteMeta(name: string): Promise<void> {
    this.meta.delete(name)
  }

  async writeMetaIfUnchanged(name: string, body: string, expected: string | null): Promise<boolean> {
    const current = this.meta.get(name) ?? null
    if (current !== expected) return false
    this.meta.set(name, body)
    return true
  }
}
