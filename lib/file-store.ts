export interface MarkdownDocument {
  path: string
  title: string
  frontmatter: Record<string, unknown>
  outboundLinks: string[]
  /**
   * The body, frontmatter stripped.
   *
   * **Present only on a document read directly from storage** — `readDocument`,
   * `buildDocument`, a write result. It is deliberately *absent* from index entries:
   * bodies were 81% of a 4.68 MB index at 2,000 documents, which the browser parsed
   * on every boot and the server rewrote on every save (docs/phase-4-scale.md).
   *
   * Anything that needs a body asks for that document. Anything that only needs to
   * describe one uses `excerpt` and `wordCount`.
   */
  content?: string
  /** First ~160 characters of prose, for context in lists. Always in the index. */
  excerpt?: string
  /** Word count, so the details panel needs no body. Always in the index. */
  wordCount?: number
  updatedAt?: string
  /** Content hash of the file as last written or read. Used for If-Match. */
  etag?: string
  /** Stable identity from frontmatter (R7). Absent until the app first saves it. */
  id?: string
  /** Alternative names this document resolves under, from frontmatter `aliases`. */
  aliases?: string[]
  /**
   * The id of this document's logical parent in the page-in-page tree.
   *
   * Sourced from `parent:` in frontmatter, then remembered in the index. The folder
   * the file lives in on disk is independent — folder nesting still exists for
   * storage, but the page hierarchy the user navigates is `parent_id` from here.
   *
   * Null when the document is a root page or has no parent set.
   */
  parent_id?: string | null
}

export interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  children?: FileTreeNode[]
}

export interface WorkspaceIndex {
  documents: Record<string, MarkdownDocument>
  tree: FileTreeNode[]
  backlinks: Record<string, string[]>
}

export interface WriteResult {
  path: string
  etag: string
  updatedAt: string
  /** The document as it now exists in the index. */
  document: MarkdownDocument
  /**
   * The bytes actually written, present only when they differ from what the caller
   * sent — today that means an `id` was injected into frontmatter (R7).
   *
   * The caller must reconcile its buffer with this, or the next save will write the
   * pre-injection text back and the id will be lost and regenerated on every save.
   */
  content?: string
}

export interface WriteOptions {
  /**
   * The etag the caller believes the file currently has. When it does not match,
   * the write is refused with a ConflictError.
   *
   * Omitting it is an unconditional write. Pass `CREATE_ONLY` to require that the
   * file does not exist yet.
   */
  ifMatch?: string
}

/** Sentinel for `ifMatch` meaning "this must be a new file". */
export const CREATE_ONLY = '*none*'

type IndexErrorBody = { error?: string; code?: string }
interface StatusError extends Error {
  status?: number
  code?: string
}

export interface RemoveResult {
  path: string
  /**
   * The trash entry holding the deleted bytes, for an undo affordance.
   *
   * Null only when there was nothing to keep — a document the index knew about but
   * storage did not.
   */
  trashId: string | null
}

/**
 * Raised when an If-Match precondition fails.
 *
 * The write is still refused — the file on storage is somebody else's newer work and
 * clobbering it is the one thing that must not happen. What changed in Phase 1 is
 * that the refused content is no longer only in a browser buffer: it is written
 * beside the document as `<name>.conflict.md`, named by `conflictPath`.
 */
export class ConflictError extends Error {
  readonly code = 'CONFLICT'
  constructor(
    message: string,
    readonly path: string,
    readonly expectedEtag: string | undefined,
    readonly actualEtag: string | undefined,
    /** Where the rejected content was preserved, when it could be. */
    readonly conflictPath?: string
  ) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND'
  constructor(readonly path: string) {
    super(`No such document: ${path}`)
    this.name = 'NotFoundError'
  }
}

export class InvalidPathError extends Error {
  readonly code = 'INVALID_PATH'
  constructor(readonly path: string, reason: string) {
    super(`Invalid path "${path}": ${reason}`)
    this.name = 'InvalidPathError'
  }
}

export interface FileStore {
  getFile(path: string): Promise<MarkdownDocument | null>
  listTree(): Promise<FileTreeNode[]>
  getIndex(): Promise<WorkspaceIndex>
}

/** The R1 write surface. Completed in Sprint 3. */
export interface WritableFileStore extends FileStore {
  write(path: string, content: string, options?: WriteOptions): Promise<WriteResult>
  move(fromPath: string, toPath: string, options?: WriteOptions): Promise<WriteResult>
  /** Move a document to the trash. Recoverable until purged. */
  remove(path: string, options?: WriteOptions): Promise<RemoveResult>
  /** Create a folder (including missing parents). */
  createDirectory(dir: string): Promise<{ path: string }>
  /** Move a folder and everything under it to the trash, as one entry. */
  removeDirectory(dir: string): Promise<{ path: string; removed: string[]; trashId: string | null }>
  /** Move a folder and all its contents. */
  moveDirectory(from: string, to: string): Promise<{ path: string; moved: string[] }>
}

/** Normalizes a workspace path to its index key form: no leading slash, forward slashes. */
export function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * Client & R2 read-only implementation of FileStore.
 * Fetches the generated index.json static asset.
 */
export class StaticFileStore implements FileStore {
  private indexCache: WorkspaceIndex | null = null
  private fetchPromise: Promise<WorkspaceIndex> | null = null

  constructor(private indexUrl: string = '/index.json') {}

  async getIndex(): Promise<WorkspaceIndex> {
    if (this.indexCache) return this.indexCache

    if (!this.fetchPromise) {
      this.fetchPromise = fetch(this.indexUrl)
        .then((res) => {
          if (!res.ok) {
            return res.json().then((body: IndexErrorBody) => {
              const err = new Error(body?.error || `Failed to load index.json: ${res.statusText}`)
              ;(err as StatusError).status = res.status
              ;(err as StatusError).code = body?.code
              throw err
            }).catch((parseErr) => {
              if ((parseErr as StatusError)?.status) throw parseErr
              throw new Error(`Failed to load index.json: ${res.statusText}`)
            })
          }
          return res.json() as Promise<WorkspaceIndex>
        })
        .then((index) => {
          this.indexCache = index
          return index
        })
        .catch((err) => {
          // Do not cache a failed fetch — a retry should get a fresh attempt.
          this.fetchPromise = null
          throw err
        })
    }

    return this.fetchPromise
  }

  async getFile(path: string): Promise<MarkdownDocument | null> {
    const index = await this.getIndex()
    return index.documents[normalizePath(path)] || index.documents[path] || null
  }

  async listTree(): Promise<FileTreeNode[]> {
    const index = await this.getIndex()
    return index.tree
  }
}
