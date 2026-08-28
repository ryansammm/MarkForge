import { it } from 'vitest'
import { MemoryBucket } from '../lib/server/bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { SearchIndex, SEARCH_FILE, snippetFor } from '../lib/server/search'

/**
 * Index-split and server-side search suite.
 *
 * Two properties, and the first one is the point of the whole change:
 *
 *   1. **The index never carries a document body.** Bodies were 81% of a 4.68 MB
 *      index at 2,000 documents, parsed by the browser on every boot and rewritten by
 *      the server on every save (docs/phase-4-scale.md). This is easy to regress —
 *      one `applyUpsert` with a full document undoes it silently, and nothing would
 *      look broken until the corpus grew.
 *
 *   2. **Search still finds things**, including a document saved a moment ago and one
 *      changed by another process entirely.
 */

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures.push(`${name}\n      ${(err as Error).message}`)
    console.error(`  FAIL ${name}`)
    console.error(`       ${(err as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

function workspace() {
  const bucket = new MemoryBucket()
  const store = new WorkspaceStore(bucket)
  return { bucket, store, search: new SearchIndex(store) }
}

/**
 * Long enough that its prose exceeds the 160-character excerpt.
 *
 * That matters for the leak check below: with a short note the whole body fits in
 * the excerpt legitimately, and the test would be asserting nothing.
 */
const NOTE = `---
tags: [meeting]
---

# Quarterly planning

We agreed to postpone the migration until the storage work lands, which pushes the
review into the following quarter and leaves the contractor booking unresolved for
another fortnight at least.

## Actions

Ask Priya about the budget for the offsite.
`

export async function runSearchTests(): Promise<boolean> {
  console.log('Index-split and search suite\n')

  console.log('the index carries no bodies')

  await check('a written document is indexed without its content', async () => {
    const { store } = workspace()
    await store.write('Notes/Planning.md', NOTE)

    const entry = (await store.getIndex()).documents['Notes/Planning.md']
    assert(entry, 'the document was not indexed')
    equal(entry.content, undefined, 'the index is still carrying the document body')
    // Text from beyond the excerpt: the excerpt deliberately holds the first ~160
    // characters, so the check has to be for something further into the document.
    assert(!JSON.stringify(entry).includes('Ask Priya'), 'the body leaked into the index')
  })

  await check('a reindex from storage also strips bodies', async () => {
    // The other way documents enter the index. If reindex kept bodies, a rebuild
    // would quietly undo the split.
    const { bucket, store } = workspace()
    await bucket.writeText('Direct.md', NOTE)
    const index = await store.reindex()

    equal(index.documents['Direct.md'].content, undefined, 'reindex put a body back into the index')
  })

  await check('the index keeps an excerpt and a word count instead', async () => {
    const { store } = workspace()
    await store.write('Notes/Planning.md', NOTE)
    const entry = (await store.getIndex()).documents['Notes/Planning.md']

    assert(entry.excerpt, 'no excerpt — the backlinks panel would have nothing to show')
    assert(entry.excerpt!.includes('postpone the migration'), 'the excerpt is not prose from the body')
    assert(!entry.excerpt!.includes('#'), 'the excerpt kept heading syntax')
    assert((entry.wordCount ?? 0) > 10, 'no word count — the details panel would show zero')
  })

  await check('an excerpt is short, and a body is not', async () => {
    const { store } = workspace()
    const long = `# Long\n\n${'word '.repeat(5000)}`
    await store.write('Long.md', long)

    const entry = (await store.getIndex()).documents['Long.md']
    assert(entry.excerpt!.length <= 161, `excerpt is ${entry.excerpt!.length} characters`)
    // 5,000 words plus the heading's one. The `#` is syntax, not a word.
    equal(entry.wordCount, 5001, 'wrong word count')

    // The whole point, stated as a size: a 25KB document costs the index ~200 bytes.
    assert(
      JSON.stringify(entry).length < 500,
      `an index entry for a 25KB document is ${JSON.stringify(entry).length} bytes`
    )
  })

  await check('a document read directly still has its body', async () => {
    // The editor and the share route both depend on this: only *index entries* are
    // stripped, not documents read from storage.
    const { store } = workspace()
    await store.write('Notes/Planning.md', NOTE)

    const read = await store.readDocument('Notes/Planning.md')
    assert(read?.document.content?.includes('postpone the migration'), 'a direct read lost the body')
  })

  console.log('\nsearch finds things')

  await check('a document is found by text in its body', async () => {
    const { store, search } = workspace()
    await store.write('Notes/Planning.md', NOTE)

    const hits = await search.query('migration')
    equal(hits.length, 1, 'the document was not found')
    equal(hits[0].path, 'Notes/Planning.md', 'wrong document')
  })

  await check('a document is found by its title', async () => {
    const { store, search } = workspace()
    await store.write('Notes/Planning.md', NOTE)
    await store.write('Other.md', '# Other\n\nnothing relevant here\n')

    const hits = await search.query('Quarterly')
    assert(hits.some((hit) => hit.path === 'Notes/Planning.md'), 'title search failed')
  })

  await check('the snippet shows the match, not the top of the document', async () => {
    const { store, search } = workspace()
    await store.write('Notes/Planning.md', NOTE)

    const [hit] = await search.query('offsite')
    assert(hit, 'no hit')
    assert(hit.snippet.includes('offsite'), `snippet does not contain the match: ${hit.snippet}`)
  })

  await check('an empty query returns nothing rather than everything', async () => {
    const { store, search } = workspace()
    await store.write('Notes/Planning.md', NOTE)
    equal(await search.query('   '), [], 'a blank query returned results')
  })

  await check('a document saved a moment ago is findable immediately', async () => {
    const { store, search } = workspace()
    await store.write('First.md', '# First\n\nnothing here\n')
    await search.query('anything') // load the corpus

    const result = await store.write('Second.md', '# Second\n\npeculiar wording\n')
    search.noteWritten('Second.md', result.document.content ?? '', result.document.title, result.etag)

    const hits = await search.query('peculiar')
    equal(hits.length, 1, 'a just-saved document was not findable')
  })

  await check('a deleted document stops being findable', async () => {
    const { store, search } = workspace()
    await store.write('Doomed.md', '# Doomed\n\nunmistakable phrase\n')
    equal((await search.query('unmistakable')).length, 1, 'setup failed')

    await store.remove('Doomed.md')
    search.noteRemoved('Doomed.md')

    equal((await search.query('unmistakable')).length, 0, 'a deleted document is still findable')
  })

  await check('a change made by another process is picked up', async () => {
    // The correctness backstop for everything noteWritten does not cover: a write on
    // another instance, a rename, a restore from trash. Reconciliation compares the
    // corpus against document etags rather than trusting any notification.
    const { bucket, store, search } = workspace()
    await store.write('Shared.md', '# Shared\n\noriginal wording\n')
    equal((await search.query('original')).length, 1, 'setup failed')

    // Another process writes the file and reindexes — exactly what a second instance
    // of this app does.
    const other = new WorkspaceStore(bucket)
    await other.write('Shared.md', '# Shared\n\nreplacement wording\n')

    // Past the staleness window, so this instance reconciles.
    await new Promise((resolve) => setTimeout(resolve, 5100))

    equal((await search.query('replacement')).length, 1, 'the out-of-band change was never picked up')
    equal((await search.query('original')).length, 0, 'the stale text is still being matched')
  })

  console.log('\ncold starts')

  await check('a snapshot lets a fresh instance search without re-reading everything', async () => {
    const { bucket, store, search } = workspace()
    for (let i = 0; i < 5; i++) await store.write(`Note ${i}.md`, `# Note ${i}\n\ndistinctive body ${i}\n`)

    await search.query('distinctive')
    await search.persist()

    const snapshot = await bucket.readMeta(SEARCH_FILE)
    assert(snapshot, 'no snapshot was written')
    assert(snapshot!.includes('distinctive body 3'), 'the snapshot does not hold document text')

    // A new instance over the same bucket: it should answer from the snapshot.
    const cold = new SearchIndex(new WorkspaceStore(bucket))
    const hits = await cold.query('distinctive')
    equal(hits.length, 5, 'a cold instance could not search')
  })

  await check('a corrupt snapshot rebuilds instead of failing', async () => {
    const { bucket, store } = workspace()
    await store.write('Note.md', '# Note\n\nrecoverable text\n')
    await bucket.writeMeta(SEARCH_FILE, 'not json at all')

    const cold = new SearchIndex(new WorkspaceStore(bucket))
    equal((await cold.query('recoverable')).length, 1, 'a corrupt snapshot broke search')
  })

  console.log('\nsnippets')

  await check('a snippet is centred on the match', () => {
    const text = `${'filler '.repeat(60)}needle ${'filler '.repeat(60)}`
    const snippet = snippetFor(text, 'needle')
    assert(snippet.includes('needle'), 'the match is missing')
    assert(snippet.startsWith('…'), 'no leading ellipsis for a mid-document match')
    assert(snippet.length < 200, `snippet is ${snippet.length} characters`)
  })

  await check('a snippet does not cut a word in half', () => {
    // "…tning-fast, privacy-focused" reads as a rendering bug, not an excerpt.
    const text = `${'antidisestablishmentarianism '.repeat(12)}needle ${'x '.repeat(40)}`
    const snippet = snippetFor(text, 'needle')
    const firstWord = snippet.replace(/^…/, '').split(' ')[0]
    assert(
      firstWord === 'antidisestablishmentarianism' || firstWord === 'needle',
      `snippet starts mid-word: ${JSON.stringify(firstWord)}`
    )
  })

  await check('a snippet falls back to the start when the term is not literal', () => {
    // Orama matches stems and typos, so the exact term is not always present.
    const snippet = snippetFor('The quick brown fox jumps over the lazy dog.', 'jumping')
    assert(snippet.startsWith('The quick'), `unexpected fallback: ${snippet}`)
  })

  await check('a snippet collapses whitespace', () => {
    equal(snippetFor('a\n\n\n   b', 'a'), 'a b', 'whitespace was not collapsed')
  })

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

it('search suite', async () => {
  if (!(await runSearchTests())) throw new Error('search suite FAILED')
}, 60000)
