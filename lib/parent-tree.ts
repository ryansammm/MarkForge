import type { MarkdownDocument } from './file-store'
import { normalizePath } from './file-store'

/**
 * The page-in-page view of the index.
 *
 * The folder tree in `index.tree` reflects where files live on disk; this
 * tree reflects where they live in the user's head. Both are honest views of
 * the same data, and both are useful — folders are a storage concern, parent
 * ids are a navigation one.
 *
 * The tree is computed from the index on demand. The index rebuild reads
 * `parent:` from each document's frontmatter into `MarkdownDocument.
 * parent_id`, so a derived tree here needs no extra state.
 */

export interface ParentTreeNode {
  /** The document. Every node is a document — folders are not part of the page tree. */
  doc: MarkdownDocument
  /** Direct children, ordered alphabetically by title. */
  children: ParentTreeNode[]
}

/**
 * Every document keyed by `parent_id`, with a synthetic `__root__` bucket
 * for the documents that have no parent. Exposed for the rare case where a
 * caller needs the buckets separately (e.g. "the root" vs "child of X").
 */
export interface ParentTreeBuckets {
  byParent: Record<string, ParentTreeNode[]>
  root: ParentTreeNode[]
}

function compareByTitle(a: MarkdownDocument, b: MarkdownDocument): number {
  return a.title.localeCompare(b.title)
}

/**
 * Group documents by `parent_id`. Documents with no `id` and no `parent_id`
 * end up in the root bucket; the cycle-prevention logic is a separate pass
 * because it needs the whole map in hand.
 */
export function bucketByParentId(docs: Record<string, MarkdownDocument>): ParentTreeBuckets {
  const byParent: Record<string, ParentTreeNode[]> = {}
  const root: ParentTreeNode[] = []

  for (const raw of Object.keys(docs)) {
    const path = normalizePath(raw)
    const doc = docs[path]
    if (!doc) continue
    const node: ParentTreeNode = { doc, children: [] }
    if (doc.parent_id) {
      const bucket = byParent[doc.parent_id] ?? (byParent[doc.parent_id] = [])
      bucket.push(node)
    } else {
      root.push(node)
    }
  }

  for (const list of Object.values(byParent)) list.sort((a, b) => compareByTitle(a.doc, b.doc))
  root.sort((a, b) => compareByTitle(a.doc, b.doc))

  return { byParent, root }
}

/**
 * Build the page tree, breaking cycles and dropping orphans.
 *
 * A document whose `parent_id` does not resolve to a known id is treated as
 * a root document. A document that is its own ancestor (directly or
 * transitively) is unparented at the highest cycle point and becomes a
 * root, because rendering a cycle in the sidebar would mean an infinite
 * recursion. The data is left as-is; only the tree is reshaped.
 */
export function buildParentTree(docs: Record<string, MarkdownDocument>): ParentTreeNode[] {
  const { byParent, root } = bucketByParentId(docs)

  // Index docs by stable id so a parent_id lookup is O(1) per node. Docs
  // without an id can still be roots but cannot be parents.
  const byId = new Map<string, MarkdownDocument>()
  for (const doc of Object.values(docs)) {
    if (doc.id) byId.set(doc.id, doc)
  }

  // Children of a doc whose id is not in the map fall through to root.
  const orphanSet = new Set<ParentTreeNode>()
  for (const [parentId, list] of Object.entries(byParent)) {
    if (!byId.has(parentId)) for (const node of list) orphanSet.add(node)
  }

  // Walk the graph once, marking every doc that is reachable from a root.
  // Anything left over is stranded by a cycle: its `parent_id` chain does
  // not lead to a root, so the only honest thing to do is to surface it
  // as a root as well.
  const reachable = new Set<string>()
  function walk(doc: MarkdownDocument): void {
    if (!doc.id || reachable.has(doc.id)) return
    reachable.add(doc.id)
    for (const child of byParent[doc.id] ?? []) walk(child.doc)
  }
  for (const node of root) walk(node.doc)

  const stranded: ParentTreeNode[] = []
  for (const list of Object.values(byParent)) {
    for (const node of list) {
      if (!node.doc.id) continue
      if (reachable.has(node.doc.id)) continue
      if (orphanSet.has(node)) continue
      stranded.push(node)
    }
  }

  const visited = new Set<string>()
  function attachChildren(node: ParentTreeNode): void {
    if (!node.doc.id) return
    if (visited.has(node.doc.id)) {
      // Cycle: stop here. The node is still in the tree; its descendants
      // are not its problem.
      return
    }
    visited.add(node.doc.id)
    const kids = byParent[node.doc.id] ?? []
    node.children = kids
    for (const child of kids) attachChildren(child)
  }

  const roots = [...root, ...orphanSet, ...stranded]
  for (const node of roots) attachChildren(node)

  return roots
}

/** Direct children of a given document, by id. Empty when the doc has no children. */
export function childrenOf(
  docs: Record<string, MarkdownDocument>,
  parentId: string
): MarkdownDocument[] {
  const kids: MarkdownDocument[] = []
  for (const doc of Object.values(docs)) {
    if (doc.parent_id === parentId) kids.push(doc)
  }
  return kids.sort(compareByTitle)
}

/**
 * The chain of ancestors from `doc` up to the root, ordered root-first.
 *
 * Stops at the first cycle, because a cycle means "you have already been
 * here" — including the cycle doc would put a duplicate in the breadcrumb
 * and surprise the user.
 */
export function ancestorChain(
  docs: Record<string, MarkdownDocument>,
  doc: MarkdownDocument
): MarkdownDocument[] {
  const byId = new Map<string, MarkdownDocument>()
  for (const d of Object.values(docs)) if (d.id) byId.set(d.id, d)

  const chain: MarkdownDocument[] = []
  const seen = new Set<string>(doc.id ? [doc.id] : [])
  let cursor: MarkdownDocument | undefined = doc
  while (cursor?.parent_id) {
    if (seen.has(cursor.parent_id)) break
    const parent = byId.get(cursor.parent_id)
    if (!parent) break
    seen.add(parent.id!)
    chain.unshift(parent)
    cursor = parent
  }
  return chain
}
