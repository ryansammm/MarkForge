import { gzipSync } from 'zlib'
import { MemoryBucket } from '../lib/server/bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { planRename, executeRename } from '../lib/server/rename'
import { SearchIndex } from '../lib/server/search'

/**
 * Corpus-scale benchmark (production-readiness plan §4.1).
 *
 * The architecture bets on a client-held index and in-memory search. That bet has
 * never been tested anywhere near where it might fail: the real corpus is two
 * documents, and every performance claim in this repository is therefore a guess.
 *
 * This measures the things that would break first, at sizes a real vault reaches:
 *
 *   - the index payload the browser downloads on boot
 *   - how long one save takes as the corpus grows, since every save rewrites the
 *     whole index
 *   - a full reindex
 *   - a rename that rewrites many inbound links
 *   - building and querying the in-memory search index
 *
 * Runs against MemoryBucket, so the numbers are the *floor*: pure CPU and
 * serialization, with no network. R2 adds a round trip per operation on top.
 *
 *   npm run benchmark            # 2,000 documents
 *   npm run benchmark -- 500
 */

const SIZES_TO_SAMPLE = [100, 500, 1000, 2000]

function words(count: number, seed: number): string {
  const vocabulary = [
    'workspace', 'markdown', 'document', 'link', 'index', 'storage', 'bucket',
    'review', 'meeting', 'decision', 'roadmap', 'customer', 'research', 'draft',
    'sprint', 'backlog', 'estimate', 'release', 'incident', 'runbook',
  ]
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(vocabulary[(seed + i * 7) % vocabulary.length])
  return out.join(' ')
}

/**
 * A document of roughly the size real notes are, with a link graph that is neither
 * a chain nor a clique — the shapes that make backlink maps behave unrealistically.
 *
 * Deliberately **no frontmatter `title:` and no H1**, so the title comes from the
 * filename. That is what makes the rename measurement mean anything: with a title in
 * frontmatter, renaming the file leaves every inbound `[[Note 42]]` still resolving,
 * so there is nothing to rewrite and the benchmark measures an empty changeset.
 */
function makeDocument(n: number, total: number): string {
  // A real vault is not evenly linked: a few index notes collect most of the inbound
  // links. One hub per 50 documents reproduces that, and it is the shape that makes
  // rename expensive — the operation the plan wants measured at ~50 inbound links.
  const hubCount = Math.max(1, Math.round(total / 50))
  const links = [
    `[[Note ${n % hubCount}]]`,
    ...[3, 7, 11, 23].map((step) => `[[Note ${(n * step) % total}]]`),
  ]

  return [
    '---',
    `tags: [bench, group-${n % 12}]`,
    '---',
    '',
    words(60, n),
    '',
    `See ${links.slice(0, 3).join(', ')} for background.`,
    '',
    '## Detail (deliberately not an H1 — see makeDocument)',
    '',
    words(90, n + 1),
    '',
    `Related: ${links.slice(3).join(' and ')}.`,
    '',
    '## Notes',
    '',
    words(70, n + 2),
    '',
    '```ts',
    'const example = { not: "prose" }',
    '```',
    '',
  ].join('\n')
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`
}

function kb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
}

async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const result = await fn()
  return [result, performance.now() - started]
}

async function main() {
  const total = Number(process.argv[2] ?? 2000)
  if (!Number.isFinite(total) || total < 10) throw new Error('Corpus size must be a number ≥ 10')

  console.log(`Corpus-scale benchmark — ${total} documents\n`)
  console.log('Backend: memory (no network). These are floor numbers; R2 adds a round trip.\n')

  const bucket = new MemoryBucket()
  const store = new WorkspaceStore(bucket)

  // --- build the corpus ------------------------------------------------------
  // Straight to the bucket: going through store.write() would rewrite the index
  // once per document, which is O(n²) serialization and is measured separately.
  let corpusBytes = 0
  for (let n = 0; n < total; n++) {
    const folder = `Area ${n % 20}`
    const content = makeDocument(n, total)
    corpusBytes += Buffer.byteLength(content, 'utf8')
    await bucket.writeText(`${folder}/Note ${n}.md`, content)
  }

  console.log(`corpus: ${kb(corpusBytes)} across ${total} documents in 20 folders\n`)

  // --- reindex ---------------------------------------------------------------
  const [index, reindexMs] = await timeIt(() => store.reindex())
  const documentCount = Object.keys(index.documents).length

  const json = JSON.stringify(index)
  const gzipped = gzipSync(json).length

  console.log('index (the payload the browser downloads before it can render)')
  console.log(`  reindex from storage      ${ms(reindexMs)}`)
  console.log(`  documents indexed         ${documentCount}`)
  console.log(`  index.json                ${kb(json.length)}`)
  // Generated prose reuses a small vocabulary, so it compresses far better than real
  // writing. Treat the gzip figure as optimistic; the uncompressed size is the honest
  // one, because that is what JSON.parse and the JS heap actually pay.
  console.log(`  gzipped (optimistic)      ${kb(gzipped)}`)

  // Since the index split, bodies are not in here at all — this asserts it rather
  // than trusting it, because the regression would be silent and only visible at size.
  const withBodies = Object.values(index.documents).filter((doc) => doc.content !== undefined)
  console.log(
    `  entries carrying a body   ${withBodies.length}` +
      (withBodies.length === 0 ? '  (bodies live in the documents)' : '  ← REGRESSION')
  )
  console.log(`  per document              ${(json.length / documentCount).toFixed(0)} bytes\n`)

  // --- save latency as the corpus grows --------------------------------------
  console.log('one save, at increasing corpus size')
  console.log('  (every save rewrites the whole index — this is where that shows)')

  for (const size of SIZES_TO_SAMPLE) {
    if (size > total) continue

    const sampleBucket = new MemoryBucket()
    const sampleStore = new WorkspaceStore(sampleBucket)
    for (let n = 0; n < size; n++) {
      await sampleBucket.writeText(`Area ${n % 20}/Note ${n}.md`, makeDocument(n, size))
    }
    await sampleStore.reindex()

    const samples: number[] = []
    for (let i = 0; i < 10; i++) {
      const [, took] = await timeIt(() =>
        sampleStore.write(`Area 0/Note 0.md`, makeDocument(i, size))
      )
      samples.push(took)
    }

    const indexBytes = JSON.stringify(await sampleStore.getIndex()).length
    console.log(
      `  ${String(size).padStart(5)} docs   p50 ${ms(percentile(samples, 50)).padStart(8)}` +
        `   p95 ${ms(percentile(samples, 95)).padStart(8)}   index ${kb(indexBytes)}`
    )
  }

  // --- rename with many inbound links ----------------------------------------
  console.log('\nrename')
  // The most-linked document, not an arbitrary one. Renaming a leaf measures nothing;
  // the cost is in rewriting inbound links, so the benchmark has to pick a hub.
  const [hubTitle] = Object.entries(index.backlinks).sort((a, b) => b[1].length - a[1].length)[0]
  const target = Object.values(index.documents).find((doc) => doc.title === hubTitle)?.path
  if (!target) throw new Error('no linked document found in the generated corpus')

  const [plan, planMs] = await timeIt(() =>
    planRename(store, target, `${target.slice(0, target.lastIndexOf('/'))}/Renamed Hub.md`)
  )
  console.log(`  plan (${plan.edits.length} documents link here)   ${ms(planMs)}`)

  const [report, renameMs] = await timeIt(() => executeRename(store, plan))
  console.log(`  execute (${report.updatedCount} rewritten, ${report.failedCount} failed)   ${ms(renameMs)}`)

  // --- search ----------------------------------------------------------------
  console.log('\nsearch (server-side, over the corpus)')
  const search = new SearchIndex(store)

  // Worst case: a cold instance with no snapshot, which has to read the whole corpus.
  const [, coldMs] = await timeIt(() => search.query('roadmap'))
  console.log(`  first query, no snapshot  ${ms(coldMs)}`)

  const [, persistMs] = await timeIt(() => search.persist())
  const snapshot = (await bucket.readMeta('search.json'))?.length ?? 0
  console.log(`  snapshot write            ${ms(persistMs)}  (${kb(snapshot)}, server-side only)`)

  // The normal case: a new instance that finds a snapshot and nothing has drifted.
  const [, warmMs] = await timeIt(() => new SearchIndex(store).query('roadmap'))
  console.log(`  first query, snapshot     ${ms(warmMs)}`)

  for (const term of ['roadmap', 'incident runbook', 'note 42', 'customer research']) {
    const [hits, took] = await timeIt(() => search.query(term))
    console.log(`  query ${JSON.stringify(term).padEnd(22)} ${ms(took).padStart(8)}  (${hits.length} shown)`)
  }

  console.log('\nDone. Record these in docs/phase-4-scale.md, with the date and the machine.')
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}`)
  process.exit(1)
})
