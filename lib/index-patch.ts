import type { FileTreeNode, MarkdownDocument, WorkspaceIndex } from './file-store'
import { normalizePath } from './file-store'

/**
 * Incremental index maintenance.
 *
 * Sprint 3's replacement for the deferred SQLite/libSQL index: read index.json,
 * patch the one entry that changed, write it back. O(1) work per edit, no schema,
 * no migrations, no second service.
 *
 * Everything here is a pure mutation of an in-memory WorkspaceIndex, so the server
 * runs it against index.json and the client runs the identical code against its
 * in-memory copy after a save — one implementation, no drift between what is on
 * disk and what the UI believes.
 *
 * Deliberately free of remark imports: document building lives in build-document.ts
 * so this stays cheap enough to ship to the browser.
 *
 * These functions and scripts/ingest.ts must stay in agreement — a full reindex and
 * a sequence of incremental patches have to land on the same index, or the ethos
 * claim ("the index is disposable") is false.
 */

/** Folders first, then by display name. Shared with the ingest CLI. */
export function compareTreeNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.isDir && !b.isDir) return -1
  if (!a.isDir && b.isDir) return 1
  return a.name.localeCompare(b.name)
}

// --- tree -------------------------------------------------------------------

function insertIntoTree(tree: FileTreeNode[], doc: MarkdownDocument): void {
  const segments = doc.path.split('/')
  const fileName = segments.pop()
  if (!fileName) return

  const dirPath = segments.join('/')
  ensureDirectory(tree, dirPath)

  // Walk down to the directory ensureDirectory just guaranteed exists.
  let level = tree
  let walked = ''
  for (const segment of segments) {
    walked = walked ? `${walked}/${segment}` : segment
    const dir = level.find((n) => n.isDir && n.path === walked)
    if (!dir || !dir.children) return
    level = dir.children
  }

  const existing = level.find((n) => !n.isDir && n.path === doc.path)
  if (existing) {
    existing.name = doc.title
  } else {
    level.push({ name: doc.title, path: doc.path, isDir: false })
  }
  level.sort(compareTreeNodes)
}

/**
 * Removes a file node, leaving its directories in place.
 *
 * Deleting the last document in a folder does not delete the folder — that is how
 * every file manager behaves, and Sprint 4 makes folders things the user creates
 * deliberately rather than side effects of a path. Removing a directory is
 * `applyRemoveDir`, and it is always an explicit act.
 */
function removeFromTree(tree: FileTreeNode[], path: string): void {
  const target = normalizePath(path)

  function strip(level: FileTreeNode[]): FileTreeNode[] {
    const next: FileTreeNode[] = []
    for (const node of level) {
      if (!node.isDir) {
        if (node.path !== target) next.push(node)
        continue
      }
      next.push({ ...node, children: strip(node.children ?? []) })
    }
    return next
  }

  const stripped = strip(tree)
  tree.length = 0
  tree.push(...stripped)
}

/** Ensures a directory node exists at `dirPath`, creating parents as needed. */
export function ensureDirectory(tree: FileTreeNode[], dirPath: string): void {
  const segments = normalizePath(dirPath).split('/').filter(Boolean)
  if (segments.length === 0) return

  let level = tree
  let walked = ''

  for (const segment of segments) {
    walked = walked ? `${walked}/${segment}` : segment
    let dir = level.find((n) => n.isDir && n.path === walked)
    if (!dir) {
      dir = { name: segment, path: walked, isDir: true, children: [] }
      level.push(dir)
      level.sort(compareTreeNodes)
    }
    if (!dir.children) dir.children = []
    level = dir.children
  }
}

/** Every document path at or beneath `dirPath`. */
export function documentsUnder(index: WorkspaceIndex, dirPath: string): string[] {
  const prefix = normalizePath(dirPath).replace(/\/+$/, '') + '/'
  return Object.keys(index.documents).filter((p) => p.startsWith(prefix))
}

// --- backlinks --------------------------------------------------------------

function removeBacklinksFrom(index: WorkspaceIndex, sourcePath: string, targets: string[]): void {
  for (const target of targets) {
    const sources = index.backlinks[target]
    if (!sources) continue
    const next = sources.filter((p) => p !== sourcePath)
    if (next.length > 0) index.backlinks[target] = next
    else delete index.backlinks[target]
  }
}

function addBacklinksFrom(index: WorkspaceIndex, sourcePath: string, targets: string[]): void {
  for (const target of targets) {
    const sources = index.backlinks[target] ?? (index.backlinks[target] = [])
    if (!sources.includes(sourcePath)) sources.push(sourcePath)
  }
}

// --- public patch operations -------------------------------------------------

/** Creates or updates a document in the index. */
/**
 * The index entry for a document: everything except its body.
 *
 * The single point where a document enters the index, so "the index never holds
 * bodies" is enforced here rather than remembered at every call site. Bodies were 81%
 * of a 4.68 MB index at 2,000 documents — parsed by the browser on every boot and
 * rewritten by the server on every save (docs/phase-4-scale.md).
 */
export function toIndexEntry(doc: MarkdownDocument): MarkdownDocument {
  const { content, ...rest } = doc
  void content
  return rest
}

export function applyUpsert(index: WorkspaceIndex, doc: MarkdownDocument): void {
  const previous = index.documents[doc.path]
  if (previous) {
    removeBacklinksFrom(index, doc.path, previous.outboundLinks)
  }

  index.documents[doc.path] = toIndexEntry(doc)
  addBacklinksFrom(index, doc.path, doc.outboundLinks)
  insertIntoTree(index.tree, doc)
}

/** Removes a document from the index. */
export function applyRemove(index: WorkspaceIndex, path: string): void {
  const target = normalizePath(path)
  const existing = index.documents[target]
  if (existing) {
    removeBacklinksFrom(index, target, existing.outboundLinks)
    delete index.documents[target]
  }
  removeFromTree(index.tree, target)
}

/**
 * Moves a document to a new path.
 *
 * Updates the moved document's own entry only. Inbound links held by *other*
 * documents are rewritten a layer up, in lib/server/rename.ts, because doing it
 * here would mean this pure function needed to read files.
 */
export function applyMove(index: WorkspaceIndex, fromPath: string, doc: MarkdownDocument): void {
  applyRemove(index, fromPath)
  applyUpsert(index, doc)
}

/** Registers a directory that has no documents in it yet. */
export function applyAddDir(index: WorkspaceIndex, dirPath: string): void {
  ensureDirectory(index.tree, dirPath)
}

/** Removes a directory and every document beneath it. */
export function applyRemoveDir(index: WorkspaceIndex, dirPath: string): void {
  const target = normalizePath(dirPath).replace(/\/+$/, '')

  for (const docPath of documentsUnder(index, target)) {
    applyRemove(index, docPath)
  }

  function strip(level: FileTreeNode[]): FileTreeNode[] {
    return level
      .filter((node) => !(node.isDir && node.path === target))
      .map((node) => (node.isDir ? { ...node, children: strip(node.children ?? []) } : node))
  }

  const stripped = strip(index.tree)
  index.tree.length = 0
  index.tree.push(...stripped)
}

/** Empty index, for the create-from-nothing case. */
export function emptyIndex(): WorkspaceIndex {
  return { documents: {}, tree: [], backlinks: {} }
}
