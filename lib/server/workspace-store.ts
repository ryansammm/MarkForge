import { createHash } from 'crypto'
import {
  ConflictError,
  CREATE_ONLY,
  InvalidPathError,
  NotFoundError,
  normalizePath,
  type FileTreeNode,
  type MarkdownDocument,
  type RemoveResult,
  type WorkspaceIndex,
  type WritableFileStore,
  type WriteOptions,
  type WriteResult,
} from '../file-store'
import {
  applyAddDir,
  applyMove,
  applyRemove,
  applyRemoveDir,
  applyUpsert,
  documentsUnder,
  emptyIndex,
  ensureDirectory,
} from '../index-patch'
import { buildDocument } from '../build-document'
import { ensureDocumentMeta } from '../markdown/frontmatter'
import type { BinaryObject, Bucket } from './bucket'
import { ASSET_PREFIX, assetKeyFor, isAssetKey } from './assets'
import {
  entryFileKey,
  entryManifestKey,
  isExpired,
  newTrashId,
  parseEntryFileKey,
  TRASH_PREFIX,
  TRASH_RETENTION_DAYS,
  type TrashEntry,
} from './trash'

/**
 * The workspace store.
 *
 * Every rule about how this app treats files lives here and nowhere else — etags,
 * If-Match preconditions, path containment, incremental index patching, id
 * assignment. Backends (filesystem, R2, memory) only move bytes.
 *
 * That split is deliberate. When this logic existed once per backend it would drift,
 * and the first casualty of drift is the claim the product rests on: that the index
 * is disposable, and a rebuild from storage alone agrees with a sequence of edits.
 * One implementation makes that a property of the code rather than a hope.
 */

export const INDEX_FILE = 'index.json'

export function computeEtag(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32)
}

/**
 * The same identity check for bytes that are not text.
 *
 * Separate from `computeEtag` rather than a widened parameter, because the two must
 * never be reachable by accident: hashing an image through the utf-8 path would give
 * a stable, plausible, and completely wrong answer — every byte sequence that is not
 * valid UTF-8 collapses onto the same replacement characters.
 */
export function computeBinaryEtag(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

/**
 * How many times an index update re-reads and re-applies before giving up.
 *
 * Each retry means another writer won the race. Five is far past what contention on
 * a personal workspace produces; exceeding it means something is wrong that a sixth
 * attempt will not fix.
 */
const INDEX_WRITE_ATTEMPTS = 5

export class WorkspaceStore implements WritableFileStore {
  /**
   * Serializes index mutations within this process, which keeps the common case
   * cheap — no contention, no retries.
   *
   * It is not sufficient on its own: on serverless there are many processes, and two
   * of them can interleave. `mutateIndex` is what makes that safe.
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly bucket: Bucket) {}

  /** The index file path. Single workspace; no scope to consult. */
  private indexFile(): string {
    return INDEX_FILE
  }

  // --- path safety ----------------------------------------------------------

  /** Validates a document key. Throws rather than returning a sanitized guess. */
  private documentKey(input: string): string {
    const key = this.folderKey(input)
    if (!key.toLowerCase().endsWith('.md')) {
      throw new InvalidPathError(input, 'must be a .md file')
    }
    return key
  }

  /**
   * Public validation for callers that batch writes outside the per-write flow
   * (bulk import). Delegates to the same guard `write` uses so the rules cannot
   * drift between the two paths.
   */
  validateDocumentKey(input: string): string {
    return this.documentKey(input)
  }

  /**
   * Containment, shared by every keyspace.
   *
   * Object storage has no `..` to resolve, so containment is a matter of refusing the
   * segment outright rather than comparing resolved paths.
   */
  private safeKey(input: string): string {
    const key = normalizePath(input.trim()).replace(/\/+$/, '')

    if (!key) throw new InvalidPathError(input, 'empty')
    if (key.includes('\0')) throw new InvalidPathError(input, 'contains a null byte')
    if (key.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      throw new InvalidPathError(input, 'contains a relative segment')
    }
    return key
  }

  /** The document checks without requiring a `.md` extension. */
  private folderKey(input: string): string {    const key = this.safeKey(input)
    /**
     * The asset namespace is not addressable as a document or a folder.
     *
     * Not tidiness. `removeDirectory` stashes the Markdown it finds in the trash and
     * then calls `deleteFolder`, which is recursive at the bucket layer — so deleting
     * a folder called `assets` in the file tree would delete every image in the vault
     * while trashing nothing, because the trash only knows how to stash and restore
     * documents. Refusing the path at the one place every write is validated is what
     * makes that unreachable, rather than one guard per call site.
     *
     * Images are written through the asset surface, which does not come through here.
     */
    if (isAssetKey(key)) {
      throw new InvalidPathError(input, `"${ASSET_PREFIX}/" is reserved for images`)
    }
    return key
  }

  /** The mirror of `folderKey`: valid only *inside* the asset namespace. */
  private assetKey(input: string): string {
    const key = this.safeKey(input)
    if (!isAssetKey(key)) {
      throw new InvalidPathError(input, `is not inside "${ASSET_PREFIX}/"`)
    }
    return key
  }

  /**
   * Folders that belong to the corpus.
   *
   * `listFolders` reports every directory a backend can see, and on all three of them
   * that includes the ones holding images: a filesystem has real directories, and R2
   * derives folders from key segments. Left alone, `assets/` and `assets/2026/` would
   * appear in the file tree as permanently empty folders — empty because `listKeys`
   * is `.md` only — and every reindex would faithfully put them back.
   *
   * Filtered here rather than in each backend so the three cannot disagree.
   */
  private async corpusFolders(): Promise<string[]> {
    return (await this.bucket.listFolders()).filter((folder) => !isAssetKey(folder))
  }

  // --- index ----------------------------------------------------------------

  private parseIndex(raw: string | null): WorkspaceIndex {
    if (!raw) return emptyIndex()
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceIndex>
      return {
        documents: parsed.documents ?? {},
        tree: parsed.tree ?? [],
        backlinks: parsed.backlinks ?? {},
      }
    } catch {
      // A corrupt index is recoverable — it is derived data. Refusing to start
      // because of it would contradict the whole "files are the truth" claim.
      return emptyIndex()
    }
  }

  private async readIndex(): Promise<WorkspaceIndex> {
    return this.parseIndex(await this.bucket.readMeta(this.indexFile()))
  }

  private async writeIndex(index: WorkspaceIndex): Promise<void> {
    await this.bucket.writeMeta(this.indexFile(), JSON.stringify(index, null, 2))
  }

  /**
   * Read, patch, compare-and-set, retry.
   *
   * Every index mutation goes through here. The alternative — read, patch, write —
   * loses an entry whenever two writers overlap: both read the same index, both add
   * a different document, and the second write erases the first one's addition. The
   * *documents* are both safely on disk, so nothing looks broken; the index is just
   * quietly missing one, until a reindex puts it back and nobody ever learns why.
   *
   * `patch` must therefore be re-runnable: it is applied to a freshly read index on
   * every attempt, not replayed onto a stale one. Every `apply*` helper qualifies.
   */
  private async mutateIndex<T>(patch: (index: WorkspaceIndex) => T): Promise<T> {
    let lastError: string | undefined

    for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
      const raw = await this.bucket.readMeta(this.indexFile())
      const index = this.parseIndex(raw)
      const result = patch(index)
      const body = JSON.stringify(index, null, 2)

      if (await this.bucket.writeMetaIfUnchanged(this.indexFile(), body, raw)) return result

      lastError = 'another writer updated the index first'
      // A short, growing pause. Two instances retrying in lockstep would otherwise
      // collide again immediately.
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
    }

    throw new Error(
      `Could not update the index after ${INDEX_WRITE_ATTEMPTS} attempts (${lastError}). ` +
        'The document itself was written; run a reindex to rebuild the index from storage.'
    )
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result
  }

  // --- reads ----------------------------------------------------------------

  async getIndex(): Promise<WorkspaceIndex> {
    return this.readIndex()
  }

  async listTree(): Promise<FileTreeNode[]> {
    return (await this.readIndex()).tree
  }

  /**
   * Reads from storage, not the index.
   *
   * The file is the source of truth. A document changed outside the app since the
   * last ingest must open with the bytes it actually has, and an etag matching them,
   * or the first save would silently clobber those changes.
   */
  async readDocument(input: string): Promise<{ document: MarkdownDocument; raw: string } | null> {
    const key = this.documentKey(input)
    const raw = await this.bucket.readText(key)
    if (raw === null) return null

    return {
      raw,
      document: buildDocument(key, raw, {
        updatedAt: await this.modifiedAt(key),
        etag: computeEtag(raw),
      }),
    }
  }

  /**
   * When the stored object was last written.
   *
   * This used to be `new Date()`, on the reasoning that a read is a fresh look at the
   * file. It is not: `updatedAt` is what the app shows as "Updated", and the client
   * patches every read into its index — so merely *opening* a document restamped it,
   * and every note in the workspace reported having been edited seconds ago. The
   * details panel said "Just now" about a document nobody had touched in months, and
   * "Recent edits" was a list of whatever had been looked at.
   *
   * Falls back to now only when the backend cannot say, which for the three real ones
   * means the object vanished between the read and this call.
   */
  private async modifiedAt(key: string): Promise<string> {
    const stat = await this.bucket.statObject(key)
    return stat?.modifiedAt ?? new Date().toISOString()
  }

  async getFile(input: string): Promise<MarkdownDocument | null> {
    return (await this.readDocument(input))?.document ?? null
  }

  private async currentEtag(key: string): Promise<string | undefined> {
    const raw = await this.bucket.readText(key)
    return raw === null ? undefined : computeEtag(raw)
  }

  /**
   * Enforces the If-Match precondition.
   *
   * Sprint 3 detects and refuses; Sprint 5 turns the refusal into a
   * `<name>.conflict.md` plus a non-blocking notice.
   */
  private async assertPrecondition(
    key: string,
    options: WriteOptions | undefined,
    { mustExist }: { mustExist: boolean }
  ): Promise<void> {
    const actual = await this.currentEtag(key)
    if (mustExist && actual === undefined) throw new NotFoundError(key)

    const expected = options?.ifMatch
    if (expected === undefined) return

    if (expected === CREATE_ONLY) {
      if (actual !== undefined) {
        throw new ConflictError(`${key} already exists`, key, expected, actual)
      }
      return
    }

    if (actual === undefined) {
      throw new ConflictError(`${key} no longer exists — it was deleted elsewhere`, key, expected, actual)
    }
    if (actual !== expected) {
      throw new ConflictError(`${key} changed since it was loaded`, key, expected, actual)
    }
  }

  // --- writes ---------------------------------------------------------------

  async write(input: string, content: string, options?: WriteOptions): Promise<WriteResult> {
    const key = this.documentKey(input)

    return this.run(async () => {
      try {
        await this.assertPrecondition(key, options, { mustExist: false })
      } catch (err) {
        throw await this.toConflictWithCopy(err, key, content)
      }

      // R7: every document the app saves carries a stable id, assigned on first
      // in-app save so documents authored elsewhere adopt one when edited here. The
      // `created` stamp rides along in the same splice — see `ensureDocumentMeta` for
      // why a creation time has to live in the document rather than be inferred from
      // the file.
      const assigned = ensureDocumentMeta(content)
      const finalContent = assigned.content

      await this.bucket.writeText(key, finalContent)

      const etag = computeEtag(finalContent)
      const updatedAt = new Date().toISOString()
      const document = buildDocument(key, finalContent, { updatedAt, etag })

      await this.mutateIndex((index) => applyUpsert(index, document))

      return {
        path: key,
        etag,
        updatedAt,
        document,
        ...(assigned.changed ? { content: finalContent } : {}),
      }
    })
  }

  async move(fromInput: string, toInput: string, options?: WriteOptions): Promise<WriteResult> {
    const from = this.documentKey(fromInput)
    const to = this.documentKey(toInput)

    return this.run(async () => {
      await this.assertPrecondition(from, options, { mustExist: true })

      if (from !== to && (await this.bucket.objectExists(to))) {
        throw new ConflictError(
          `${to} already exists`,
          to,
          CREATE_ONLY,
          await this.currentEtag(to)
        )
      }

      const content = await this.bucket.readText(from)
      if (content === null) throw new NotFoundError(from)

      // Copy before delete. Object storage has no atomic rename, so if the write
      // fails the source is still there — losing the destination is recoverable,
      // losing both is not.
      await this.bucket.writeText(to, content)
      if (from !== to) await this.bucket.deleteObject(from)

      const etag = computeEtag(content)
      const updatedAt = new Date().toISOString()
      const document = buildDocument(to, content, { updatedAt, etag })

      await this.mutateIndex((index) => applyMove(index, from, document))

      return { path: to, etag, updatedAt, document }
    })
  }

  /**
   * Deletes a document — into the trash, not into nothing.
   *
   * The bytes move to the metadata namespace, where nothing that reads the corpus can
   * see them, and stay there until `purgeTrash` or a restore. The returned `trashId`
   * is what an undo affordance needs.
   */
  async remove(input: string, options?: WriteOptions): Promise<RemoveResult> {
    const key = this.documentKey(input)

    return this.run(async () => {
      await this.assertPrecondition(key, options, { mustExist: true })

      const content = await this.bucket.readText(key)
      const trashId =
        content === null
          ? null
          : await this.stashInTrash({
              kind: 'document',
              path: key,
              label: key.split('/').pop() ?? key,
              files: [{ path: key, content }],
            })

      await this.bucket.deleteObject(key)
      await this.mutateIndex((index) => applyRemove(index, key))

      return { path: key, trashId }
    })
  }

  // --- assets ---------------------------------------------------------------

  /**
   * Stores an image and returns the key a document should link to.
   *
   * Deliberately outside `this.run()`. That queue exists to serialize *index*
   * mutations, and an asset touches no index — putting uploads in it would make a
   * five-image drop wait behind every document save in flight, to protect a data
   * structure none of the five appear in.
   *
   * The write is idempotent for the same file: the key is derived from the bytes, so
   * re-uploading overwrites identical content with identical content. Nothing has to
   * check whether it is already there.
   *
   * The caller is responsible for having sniffed `contentType` from the bytes rather
   * than trusting the request — see `sniffImageType`.
   */
  async writeAsset(input: {
    bytes: Uint8Array
    contentType: string
    filename?: string
  }): Promise<{ path: string; bytes: number; contentType: string }> {
    const key = assetKeyFor(input)
    await this.bucket.writeBinary(key, input.bytes, input.contentType)

    return { path: key, bytes: input.bytes.byteLength, contentType: input.contentType }
  }

  /**
   * Reads an image back.
   *
   * Null covers both "no such key" and nothing else — the caller turns it into a 404.
   * A path outside the asset namespace throws instead of returning null, because that
   * is a caller bug rather than a missing file: this is not a way to read documents.
   */
  async readAsset(input: string): Promise<BinaryObject | null> {
    return this.bucket.readBinary(this.assetKey(input))
  }

  // --- directories ----------------------------------------------------------

  /**
   * Creates a folder, parents included.
   *
   * Folders are first-class from Sprint 4 on: they exist because the user made
   * them, not because a document path implied them, and they survive the deletion
   * of their last document.
   */
  async createDirectory(input: string): Promise<{ path: string }> {
    const key = this.folderKey(input)

    return this.run(async () => {
      if (await this.bucket.objectExists(key)) {
        throw new InvalidPathError(input, 'a file already exists at that path')
      }

      await this.bucket.createFolder(key)
      await this.mutateIndex((index) => applyAddDir(index, key))

      return { path: key }
    })
  }

  async listDirectory(input: string): Promise<string[]> {
    return documentsUnder(await this.readIndex(), this.folderKey(input))
  }

  /**
   * Deletes a folder and everything under it, into the trash as one entry.
   *
   * One entry rather than one per document, so restoring puts the folder back as it
   * was instead of asking someone to reassemble it a file at a time.
   */
  async removeDirectory(input: string): Promise<{ path: string; removed: string[]; trashId: string | null }> {
    const key = this.folderKey(input)

    return this.run(async () => {
      if (!(await this.bucket.folderExists(key))) throw new NotFoundError(key)

      // From storage, not the index: the index is a cache, and a document it has
      // not caught up with is still a document somebody would want back.
      const keys = await this.bucket.listKeys(key)
      const files: Array<{ path: string; content: string }> = []
      for (const documentKey of keys) {
        const content = await this.bucket.readText(documentKey)
        if (content !== null) files.push({ path: documentKey, content })
      }

      const trashId = await this.stashInTrash({
        kind: 'folder',
        path: key,
        label: key.split('/').pop() ?? key,
        files,
      })

      await this.bucket.deleteFolder(key)

      const removed = await this.mutateIndex((index) => {
        const under = documentsUnder(index, key)
        applyRemoveDir(index, key)
        return under
      })

      return { path: key, removed, trashId }
    })
  }

  /**
   * Moves a folder and every document beneath it.
   *
   * Titles come from filenames, which a folder move leaves alone, so no inbound
   * wikilink needs rewriting — the graph is keyed by title, not path.
   */
  async moveDirectory(fromInput: string, toInput: string): Promise<{ path: string; moved: string[] }> {
    const from = this.folderKey(fromInput)
    const to = this.folderKey(toInput)

    return this.run(async () => {
      if (!(await this.bucket.folderExists(from))) throw new NotFoundError(from)
      if (to === from) return { path: to, moved: [] }
      if (to.startsWith(`${from}/`)) {
        throw new InvalidPathError(toInput, 'cannot move a folder inside itself')
      }
      if (await this.bucket.folderExists(to)) {
        throw new ConflictError(`${to} already exists`, to, CREATE_ONLY, undefined)
      }

      const keys = await this.bucket.listKeys(from)

      await this.bucket.createFolder(to)

      // The bucket work happens first and the index patch is assembled as it goes,
      // rather than applied as it goes: `mutateIndex` may re-run its patch against a
      // freshly read index, so the patch has to be a value, not a side effect.
      const moved: string[] = []
      const moves: Array<{ from: string; document: MarkdownDocument }> = []

      for (const oldKey of keys) {
        const newKey = to + oldKey.slice(from.length)
        const content = await this.bucket.readText(oldKey)
        if (content === null) continue

        await this.bucket.writeText(newKey, content)
        moved.push(oldKey)

        moves.push({
          from: oldKey,
          document: buildDocument(newKey, content, {
            updatedAt: new Date().toISOString(),
            etag: computeEtag(content),
          }),
        })
      }

      await this.bucket.deleteFolder(from)

      // Folders that held no documents still have to survive the move, or an empty
      // structure the user built by hand would silently vanish.
      const folders = (await this.corpusFolders()).filter(
        (folder) => folder === to || folder.startsWith(`${to}/`)
      )

      await this.mutateIndex((index) => {
        for (const move of moves) applyMove(index, move.from, move.document)
        for (const folder of folders) ensureDirectory(index.tree, folder)
        applyRemoveDir(index, from)
        applyAddDir(index, to)
      })

      return { path: to, moved: moved.sort() }
    })
  }

  // --- trash ----------------------------------------------------------------

  /** Copies documents into the trash namespace and records a manifest. */
  private async stashInTrash(input: {
    kind: TrashEntry['kind']
    path: string
    label: string
    files: Array<{ path: string; content: string }>
  }): Promise<string> {
    const id = newTrashId()

    // Bytes first, manifest last. A manifest with no bytes behind it would offer a
    // restore that silently produces empty files; orphaned bytes with no manifest
    // are merely invisible, and `purgeTrash` sweeps them.
    for (const file of input.files) {
      await this.bucket.writeMeta(entryFileKey(id, file.path), file.content)
    }

    const entry: TrashEntry = {
      id,
      kind: input.kind,
      path: input.path,
      label: input.label,
      deletedAt: new Date().toISOString(),
      files: input.files.map((file) => file.path),
    }
    await this.bucket.writeMeta(entryManifestKey(id), JSON.stringify(entry, null, 2))

    return id
  }

  private async readTrashEntry(id: string): Promise<TrashEntry | null> {
    const raw = await this.bucket.readMeta(entryManifestKey(id))
    if (!raw) return null
    try {
      return JSON.parse(raw) as TrashEntry
    } catch {
      return null
    }
  }

  /** Everything currently recoverable, newest first. */
  async listTrash(): Promise<TrashEntry[]> {
    const keys = await this.bucket.listMeta(TRASH_PREFIX)
    const entries: TrashEntry[] = []

    for (const key of keys) {
      if (!key.endsWith('/entry.json')) continue
      const id = key.slice(TRASH_PREFIX.length, key.length - '/entry.json'.length)
      const entry = await this.readTrashEntry(id)
      if (entry) entries.push(entry)
    }

    return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  /**
   * Puts a trashed entry back.
   *
   * A path that has been reoccupied since the delete is **skipped, never
   * overwritten** — restoring something must not destroy something. Those files stay
   * in the trash, and the entry stays with them, so a partial restore loses nothing
   * and can be finished by hand.
   */
  async restoreFromTrash(id: string): Promise<{ entry: TrashEntry; restored: string[]; skipped: string[] }> {
    return this.run(async () => {
      const entry = await this.readTrashEntry(id)
      if (!entry) throw new NotFoundError(`${TRASH_PREFIX}${id}`)

      const restored: string[] = []
      const skipped: string[] = []
      const documents: MarkdownDocument[] = []

      for (const documentPath of entry.files) {
        if (await this.bucket.objectExists(documentPath)) {
          skipped.push(documentPath)
          continue
        }

        const content = await this.bucket.readMeta(entryFileKey(id, documentPath))
        if (content === null) {
          skipped.push(documentPath)
          continue
        }

        await this.bucket.writeText(documentPath, content)
        restored.push(documentPath)
        documents.push(
          buildDocument(documentPath, content, {
            updatedAt: new Date().toISOString(),
            etag: computeEtag(content),
          })
        )
      }

      if (entry.kind === 'folder') await this.bucket.createFolder(entry.path)

      await this.mutateIndex((index) => {
        if (entry.kind === 'folder') applyAddDir(index, entry.path)
        for (const document of documents) applyUpsert(index, document)
      })

      // The entry only goes away once there is nothing left in it worth keeping.
      if (skipped.length === 0) {
        for (const documentPath of entry.files) {
          await this.bucket.deleteMeta(entryFileKey(id, documentPath))
        }
        await this.bucket.deleteMeta(entryManifestKey(id))
      }

      return { entry, restored, skipped }
    })
  }

  /**
   * Removes trashed entries past their retention window.
   *
   * Also sweeps orphaned files — bytes whose manifest never landed, or whose entry
   * was already cleared. Without that, a failure between the two writes in
   * `stashInTrash` would leave storage nobody can ever see or reclaim.
   */
  async purgeTrash(options: { now?: number; retentionDays?: number } = {}): Promise<{ purged: string[] }> {
    const now = options.now ?? Date.now()
    const retentionDays = options.retentionDays ?? TRASH_RETENTION_DAYS

    const keys = await this.bucket.listMeta(TRASH_PREFIX)
    const entries = await this.listTrash()
    const live = new Set(entries.filter((entry) => !isExpired(entry, now, retentionDays)).map((e) => e.id))

    const purged: string[] = []
    for (const key of keys) {
      const owner = key.endsWith('/entry.json')
        ? key.slice(TRASH_PREFIX.length, key.length - '/entry.json'.length)
        : parseEntryFileKey(key)?.id
      if (owner === undefined || live.has(owner)) continue

      await this.bucket.deleteMeta(key)
      purged.push(key)
    }

    return { purged }
  }

  // --- conflicts ------------------------------------------------------------

  /**
   * Turns a refused write into a refused write *plus a copy of what was refused*.
   *
   * Detecting the conflict was never the hard part — the `If-Match` precondition has
   * done that since Sprint 3. The problem was what happened next: the rejected text
   * existed only in a browser buffer, and the honest report "your save was refused"
   * was still followed by the user losing what they had typed. The copy makes the
   * refusal survivable, and both callers that can refuse — a save and a rename's
   * per-file link rewrite — come through here rather than growing separate answers.
   *
   * `CREATE_ONLY` collisions are excluded: nothing has been lost when a file the
   * caller asked to create already exists, and writing a conflict copy of a brand new
   * document would litter the corpus.
   *
   * A copy is only ever worth making when it holds something the corpus does not
   * already have. The two exemptions below are cheap to check and between them account
   * for every copy that turned out to be litter rather than a rescue.
   */
  private async toConflictWithCopy(err: unknown, key: string, content: string): Promise<unknown> {
    if (!(err instanceof ConflictError)) return err
    if (err.expectedEtag === CREATE_ONLY) return err

    // The refused text is already what the file says. The precondition was still
    // right to refuse — the caller was working from an etag that has been replaced —
    // but there is nothing here to rescue, and saving the document beside itself is
    // the most confusing possible way to report that.
    if (err.actualEtag !== undefined && computeEtag(content) === err.actualEtag) return err

    let conflictPath: string
    try {
      conflictPath = await this.writeConflictCopy(key, content)
    } catch {
      // Failing to write the copy must not replace the conflict with a different
      // error — the caller still needs to hear that its write was refused.
      return err
    }

    return new ConflictError(err.message, err.path, err.expectedEtag, err.actualEtag, conflictPath)
  }

  /**
   * `Note.md` → `Note.conflict.md`, or `Note.conflict-2.md` when that is taken.
   *
   * An existing copy holding exactly these bytes is returned as-is rather than
   * numbered past. Refusals repeat — the etag stays stale until somebody resolves it —
   * and a numbered copy per attempt buries the one copy that matters under duplicates
   * of itself, which is the opposite of preserving it.
   */
  private async writeConflictCopy(key: string, content: string): Promise<string> {
    const base = key.replace(/\.md$/i, '')

    let target = `${base}.conflict.md`
    for (let n = 2; await this.bucket.objectExists(target); n++) {
      if ((await this.bucket.readText(target)) === content) return target
      target = `${base}.conflict-${n}.md`
      if (n > 50) throw new Error(`too many conflict copies for ${key}`)
    }

    await this.bucket.writeText(target, content)

    const document = buildDocument(target, content, {
      updatedAt: new Date().toISOString(),
      etag: computeEtag(content),
    })
    await this.mutateIndex((index) => applyUpsert(index, document))

    return target
  }

  // --- maintenance ----------------------------------------------------------

  /**
   * Rebuilds the index from storage alone.
   *
   * This is the Sprint 5 reindex drill in method form, and it is the proof that the
   * index is disposable. Nothing here reads the existing index.
   */
  async reindex(): Promise<WorkspaceIndex> {
    return this.run(async () => {
      const index = emptyIndex()

      for (const folder of await this.corpusFolders()) {
        ensureDirectory(index.tree, folder)
      }

      for (const key of await this.bucket.listKeys()) {
        const raw = await this.bucket.readText(key)
        if (raw === null) continue
        applyUpsert(
          index,
          buildDocument(key, raw, {
            updatedAt: await this.modifiedAt(key),
            etag: computeEtag(raw),
          })
        )
      }

      await this.writeIndex(index)
      return index
    })
  }
}
