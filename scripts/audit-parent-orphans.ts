// Audit: any orphan parent_id in the live R2 index?
import { buildParentTree } from '../lib/parent-tree'
import type { MarkdownDocument } from '../lib/file-store'

const BASE = process.env.MF_URL ?? 'http://127.0.0.1:3000'
const PIN = process.env.APP_PIN ?? '123098'

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = setCookie.match(/(markforge_session=[^;]+)/)
  if (!match) throw new Error('no session cookie')
  return match[1]
}

async function fetchIndex(cookie: string): Promise<Record<string, MarkdownDocument>> {
  const res = await fetch(`${BASE}/api/index`, { headers: { cookie } })
  if (!res.ok) throw new Error(`index failed: ${res.status}`)
  const j = (await res.json()) as { documents: Record<string, MarkdownDocument> }
  return j.documents
}

function bucketOrphans(docs: Record<string, MarkdownDocument>): {
  byId: Map<string, MarkdownDocument>
  orphans: { doc: MarkdownDocument; reason: 'parent_id_not_resolved' }[]
  cycles: { doc: MarkdownDocument; chain: string[] }[]
  noIdParents: { doc: MarkdownDocument; children: string[] }[]
} {
  const byId = new Map<string, MarkdownDocument>()
  for (const doc of Object.values(docs)) if (doc.id) byId.set(doc.id, doc)

  const orphans: { doc: MarkdownDocument; reason: 'parent_id_not_resolved' }[] = []
  for (const doc of Object.values(docs)) {
    if (doc.parent_id && !byId.has(doc.parent_id)) {
      orphans.push({ doc, reason: 'parent_id_not_resolved' })
    }
  }

  const cycles: { doc: MarkdownDocument; chain: string[] }[] = []
  for (const doc of Object.values(docs)) {
    if (!doc.id) continue
    const seen = new Set<string>([doc.id])
    const chain: string[] = []
    let cursor: MarkdownDocument | undefined = doc
    while (cursor?.parent_id) {
      if (seen.has(cursor.parent_id)) {
        cycles.push({ doc, chain })
        break
      }
      const parent = byId.get(cursor.parent_id)
      if (!parent) break
      seen.add(parent.id!)
      chain.push(parent.id!)
      cursor = parent
    }
  }

  const noIdParents: { doc: MarkdownDocument; children: string[] }[] = []
  for (const doc of Object.values(docs)) {
    if (doc.id) continue
    const children: string[] = []
    for (const child of Object.values(docs)) {
      if (child.parent_id) children.push(child.title)
    }
    if (children.length) noIdParents.push({ doc, children })
  }

  return { byId, orphans, cycles, noIdParents }
}

function walkDepth(doc: MarkdownDocument, byId: Map<string, MarkdownDocument>): number {
  let depth = 0
  const seen = new Set<string>(doc.id ? [doc.id] : [])
  let cursor: MarkdownDocument | undefined = doc
  while (cursor?.parent_id) {
    if (seen.has(cursor.parent_id)) break
    const parent = byId.get(cursor.parent_id)
    if (!parent) break
    seen.add(parent.id!)
    depth++
    cursor = parent
  }
  return depth
}

async function main() {
  const cookie = await login()
  const docs = await fetchIndex(cookie)
  const keys = Object.keys(docs)
  console.log(`docs: ${keys.length}`)

  const withParent = Object.values(docs).filter((d) => d.parent_id)
  const withId = Object.values(docs).filter((d) => d.id)
  console.log(`with id: ${withId.length}`)
  console.log(`with parent_id: ${withParent.length}`)

  const { orphans, cycles, noIdParents } = bucketOrphans(docs)
  console.log(`orphans (parent_id does not resolve to any known id): ${orphans.length}`)
  for (const o of orphans.slice(0, 20)) {
    console.log(`  - ${o.doc.title}  parent_id=${o.doc.parent_id}  path=${o.doc.path}`)
  }
  if (orphans.length > 20) console.log(`  ... and ${orphans.length - 20} more`)

  console.log(`cycles: ${cycles.length}`)
  for (const c of cycles.slice(0, 20)) {
    console.log(`  - ${c.doc.title}  chain=[${c.chain.join(' -> ')}]`)
  }

  console.log(`noId parents (children of a parentless doc, harmless): ${noIdParents.length}`)

  // Depth distribution
  const { byId } = bucketOrphans(docs)
  const depths: number[] = Object.values(docs).map((d) => walkDepth(d, byId))
  const max = Math.max(0, ...depths)
  const dist = new Map<number, number>()
  for (const d of depths) dist.set(d, (dist.get(d) ?? 0) + 1)
  console.log(`max depth: ${max}`)
  for (const [d, n] of [...dist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  depth ${d}: ${n}`)
  }

  // Sanity: re-run buildParentTree, count roots
  const roots = buildParentTree(docs)
  console.log(`buildParentTree roots: ${roots.length}`)
  console.log(`root titles:`)
  for (const r of roots.slice(0, 20)) console.log(`  - ${r.doc.title}`)
  if (roots.length > 20) console.log(`  ... and ${roots.length - 20} more`)

  if (orphans.length === 0 && cycles.length === 0) {
    console.log('OK — no orphans, no cycles.')
  } else {
    console.log('WARN — see above.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
