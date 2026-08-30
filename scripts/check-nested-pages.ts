/**
 * Self-check for the page-in-page primitives.
 *
 * Exercises:
 *   - buildDocument reads `parent:` from frontmatter into parent_id.
 *   - slugifyTitle handles a few Unicode cases the corpus has actually hit.
 *   - planTurnSelectionIntoPage picks a usable path, body, and wikilink.
 *   - planTurnSelectionIntoPage disambiguates on collision.
 *   - buildParentTree groups by parent_id, breaks cycles, drops orphans.
 *   - ancestorChain walks to the root and stops at a cycle.
 *
 * Run with `node_modules/.bin/tsx scripts/check-nested-pages.ts`. The script
 * exits 1 on the first failed assertion.
 */
import assert from 'node:assert/strict'
import { buildDocument } from '../lib/build-document'
import { planTurnSelectionIntoPage, slugifyTitle } from '../lib/client/turn-into-page'
import { ancestorChain, buildParentTree, childrenOf } from '../lib/parent-tree'
import type { MarkdownDocument } from '../lib/file-store'

function buildDoc(path: string, content: string): MarkdownDocument {
  return buildDocument(path, content, { updatedAt: '2026-08-30T00:00:00Z', etag: 'x' })
}

// 1. parent_id from frontmatter.
{
  const doc = buildDoc('Notes.md', '---\nparent: abc123\n---\nbody\n')
  assert.equal(doc.parent_id, 'abc123', 'parent_id read from frontmatter')
}
{
  const doc = buildDoc('Notes.md', '---\ntitle: x\n---\nbody\n')
  assert.equal(doc.parent_id, null, 'missing parent → null')
}
{
  const doc = buildDoc('Notes.md', '---\nparent: ""\n---\nbody\n')
  assert.equal(doc.parent_id, null, 'empty parent string → null')
}
console.log('PASS  buildDocument reads parent_id from frontmatter')

// 2. slugify.
{
  assert.equal(slugifyTitle('Hello World'), 'Hello-World')
  assert.equal(slugifyTitle('  ##  My Note  '), 'My-Note')
  assert.equal(slugifyTitle('Café résumé'), 'Cafe-resume')
  assert.equal(slugifyTitle('???'), 'Untitled-page')
  assert.equal(slugifyTitle(''), 'Untitled-page')
}
console.log('PASS  slugifyTitle handles real cases')

// 3. planTurnSelectionIntoPage.
{
  const plan = planTurnSelectionIntoPage({
    parentPath: 'Notes.md',
    parentBody: 'before\nThe quick brown fox\nafter',
    selection: { from: 'before\n'.length, to: 'before\nThe quick brown fox'.length },
  })
  assert.equal(plan.newDocPath, 'The-quick-brown-fox.md')
  assert.equal(plan.newParentBody, 'before\n[[The-quick-brown-fox]]\nafter')
  assert.equal(plan.wikilink, '[[The-quick-brown-fox]]')
  assert.ok(plan.newDocBody.startsWith('## The quick brown fox\n\n'), 'new doc has heading + body')
}
console.log('PASS  planTurnSelectionIntoPage: heading + wikilink + sibling path')

// 4. Disambiguate on collision.
{
  const existing: Record<string, MarkdownDocument> = {
    'The-quick-brown-fox.md': buildDoc('The-quick-brown-fox.md', 'old'),
  }
  const plan = planTurnSelectionIntoPage({
    parentPath: 'Notes.md',
    parentBody: 'before\nThe quick brown fox\nafter',
    selection: { from: 'before\n'.length, to: 'before\nThe quick brown fox'.length },
    allDocs: existing,
  })
  assert.equal(plan.newDocPath, 'The-quick-brown-fox-2.md')
  assert.equal(plan.slug, 'The-quick-brown-fox')
  assert.equal(plan.wikilink, '[[The-quick-brown-fox-2]]')
}
console.log('PASS  planTurnSelectionIntoPage: disambiguates on collision')

// 5. buildParentTree.
{
  const root = buildDoc('Root.md', '---\nid: root\n---\n')
  const a = buildDoc('A.md', '---\nid: a\nparent: root\n---\n')
  const b = buildDoc('B.md', '---\nid: b\nparent: root\n---\n')
  const a1 = buildDoc('A1.md', '---\nid: a1\nparent: a\n---\n')
  const docs: Record<string, MarkdownDocument> = {
    [root.path]: root,
    [a.path]: a,
    [b.path]: b,
    [a1.path]: a1,
  }
  const tree = buildParentTree(docs)
  assert.equal(tree.length, 1, 'one root')
  assert.equal(tree[0].doc.path, 'Root.md')
  assert.deepEqual(
    tree[0].children.map((c) => c.doc.path).sort(),
    ['A.md', 'B.md']
  )
  const aNode = tree[0].children.find((c) => c.doc.path === 'A.md')!
  assert.equal(aNode.children.length, 1)
  assert.equal(aNode.children[0].doc.path, 'A1.md')
}
console.log('PASS  buildParentTree: nests children by parent_id')

// 6. Cycle is broken.
{
  const a = buildDoc('A.md', '---\nid: a\nparent: b\n---\n')
  const b = buildDoc('B.md', '---\nid: b\nparent: a\n---\n')
  const tree = buildParentTree({ [a.path]: a, [b.path]: b })
  // Both end up as roots, neither is a child of the other.
  assert.equal(tree.length, 2, 'cycle broken — both become roots')
}
console.log('PASS  buildParentTree: cycle is broken')

// 7. Orphan parent_id falls through to root.
{
  const orphan = buildDoc('X.md', '---\nid: x\nparent: ghost\n---\n')
  const tree = buildParentTree({ [orphan.path]: orphan })
  assert.equal(tree.length, 1, 'unknown parent_id → root')
}
console.log('PASS  buildParentTree: unknown parent_id → root')

// 8. childrenOf + ancestorChain.
{
  const root = buildDoc('Root.md', '---\nid: root\n---\n')
  const a = buildDoc('A.md', '---\nid: a\nparent: root\n---\n')
  const a1 = buildDoc('A1.md', '---\nid: a1\nparent: a\n---\n')
  const docs: Record<string, MarkdownDocument> = {
    [root.path]: root,
    [a.path]: a,
    [a1.path]: a1,
  }
  assert.deepEqual(
    childrenOf(docs, 'root').map((d) => d.path),
    ['A.md']
  )
  const chain = ancestorChain(docs, a1)
  assert.deepEqual(chain.map((d) => d.path), ['Root.md', 'A.md'])
}
console.log('PASS  childrenOf and ancestorChain walk the tree')

console.log('\nAll nested-pages checks passed.')
