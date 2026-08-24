import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MemoryBucket } from '../lib/server/bucket'
import { FsBucket } from '../lib/server/fs-bucket'
import { WorkspaceStore, computeEtag } from '../lib/server/workspace-store'
import { ConflictError, type WorkspaceIndex } from '../lib/file-store'
import { isExpired, newTrashId, parseEntryFileKey, TRASH_PREFIX } from '../lib/server/trash'

/**
 * Data-safety suite (production-readiness plan, Phase 1).
 *
 * Three properties, each of which was a way to lose someone's writing:
 *
 *   1.1  Deleting moves bytes to the trash and they come back intact.
 *   1.4  Concurrent index updates converge — the failure this replaces was silent,
 *        self-healing, and therefore never going to be noticed by a user.
 *   1.5  A refused save preserves what was refused instead of leaving it in a
 *        browser buffer that is about to be closed.
 */

let passed = 0
const failures: string[] = []
const cleanups: Array<() => void> = []

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

function memoryStore(): WorkspaceStore {
  return new WorkspaceStore(new MemoryBucket())
}

function fsStore(): { store: WorkspaceStore; dir: string; notes: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-safety-'))
  const notes = path.join(dir, 'notes')
  fs.mkdirSync(notes, { recursive: true })
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    notes,
    store: new WorkspaceStore(new FsBucket({ notesDir: notes, metaDir: dir, indexPath: path.join(dir, 'index.json') })),
  }
}

/** Indexes are compared as sets of paths — timestamps differ run to run. */
function documentPaths(index: WorkspaceIndex): string[] {
  return Object.keys(index.documents).sort()
}

async function run() {
  console.log('Data-safety suite (Phase 1)\n')

  console.log('1.1 — the trash')

  await check('deleting a document keeps its bytes and reports a trash id', async () => {
    const store = memoryStore()
    await store.write('Notes/Keep.md', '# Keep\n\nImportant.\n')

    const result = await store.remove('Notes/Keep.md')
    assert(result.trashId, 'no trash id reported — nothing to undo with')

    equal(await store.getFile('Notes/Keep.md'), null, 'the document is still readable after deletion')
    const index = await store.getIndex()
    equal(documentPaths(index), [], 'the index still lists a deleted document')

    const entries = await store.listTrash()
    equal(entries.length, 1, 'the delete did not reach the trash')
    equal(entries[0].kind, 'document', 'wrong entry kind')
    equal(entries[0].files, ['Notes/Keep.md'], 'wrong files captured')
  })

  await check('restoring brings the document back byte-for-byte', async () => {
    const store = memoryStore()
    const original = '# Keep\n\nImportant, with a [[Link]].\n'
    const written = await store.write('Notes/Keep.md', original)

    const { trashId } = await store.remove('Notes/Keep.md')
    const restored = await store.restoreFromTrash(trashId!)

    equal(restored.restored, ['Notes/Keep.md'], 'wrong files restored')
    equal(restored.skipped, [], 'something was skipped unexpectedly')

    const back = await store.readDocument('Notes/Keep.md')
    assert(back, 'the document did not come back')
    // Compared against what was actually written, which includes the id the first
    // save injected — the restored file must be the file, not the submission.
    equal(back!.raw, written.content, 'restored bytes differ from what was deleted')
    equal(computeEtag(back!.raw), written.etag, 'restored etag differs')

    const index = await store.getIndex()
    equal(documentPaths(index), ['Notes/Keep.md'], 'the index did not pick the document back up')
    equal(index.backlinks['Link'], ['Notes/Keep.md'], 'backlinks were not rebuilt on restore')
  })

  await check('a trashed document is invisible to a full reindex', async () => {
    // The whole reason the trash lives in the metadata namespace. If a reindex could
    // see it, a deleted document would reappear the next time the index was rebuilt.
    const store = memoryStore()
    await store.write('Gone.md', '# Gone\n')
    await store.remove('Gone.md')

    const index = await store.reindex()
    equal(documentPaths(index), [], 'a reindex resurrected a deleted document')
    equal((await store.listTrash()).length, 1, 'the reindex consumed the trash entry')
  })

  await check('deleting a folder trashes its documents as one entry', async () => {
    const store = memoryStore()
    await store.write('Doomed/One.md', '# One\n')
    await store.write('Doomed/Two.md', '# Two\n')
    await store.write('Keeper.md', '# Keeper\n')

    const result = await store.removeDirectory('Doomed')
    equal(result.removed, ['Doomed/One.md', 'Doomed/Two.md'], 'wrong documents reported')

    const entries = await store.listTrash()
    equal(entries.length, 1, 'a folder delete should be one entry, not one per file')
    equal(entries[0].files, ['Doomed/One.md', 'Doomed/Two.md'], 'wrong files captured')

    const restored = await store.restoreFromTrash(result.trashId!)
    equal(restored.restored, ['Doomed/One.md', 'Doomed/Two.md'], 'the folder did not come back whole')
    equal(documentPaths(await store.getIndex()), ['Doomed/One.md', 'Doomed/Two.md', 'Keeper.md'], 'wrong index after restore')
  })

  await check('restoring never overwrites a path that has been reoccupied', async () => {
    const store = memoryStore()
    await store.write('Note.md', '# Original\n')
    const { trashId } = await store.remove('Note.md')

    // Somebody wrote a new document at the same path in the meantime.
    await store.write('Note.md', '# Replacement\n')

    const result = await store.restoreFromTrash(trashId!)
    equal(result.restored, [], 'a restore overwrote a live document')
    equal(result.skipped, ['Note.md'], 'the collision was not reported')

    const current = await store.readDocument('Note.md')
    assert(current!.raw.includes('Replacement'), 'the live document was clobbered')

    // Nothing was lost: the entry survives so the skipped bytes remain recoverable.
    equal((await store.listTrash()).length, 1, 'a partial restore discarded the entry')
  })

  await check('a fully restored entry is cleared from the trash', async () => {
    const store = memoryStore()
    await store.write('Note.md', '# Note\n')
    const { trashId } = await store.remove('Note.md')
    await store.restoreFromTrash(trashId!)
    equal((await store.listTrash()).length, 0, 'the entry outlived its restore')
  })

  await check('purge removes entries past retention and keeps the rest', async () => {
    const store = memoryStore()
    await store.write('Old.md', '# Old\n')
    await store.write('New.md', '# New\n')
    await store.remove('Old.md')
    await store.remove('New.md')

    const day = 24 * 60 * 60 * 1000
    // 40 days on, with a 30-day window: both entries were created now, so neither
    // is expired at `now`, and both are at `now + 40 days`.
    equal((await store.purgeTrash({ now: Date.now() })).purged, [], 'purged something inside its retention window')
    const purged = await store.purgeTrash({ now: Date.now() + 40 * day })
    assert(purged.purged.length > 0, 'nothing was purged past retention')
    equal((await store.listTrash()).length, 0, 'expired entries survived the purge')
  })

  await check('purge sweeps orphaned bytes with no manifest', async () => {
    // The failure window in stashInTrash: bytes written, manifest not. Without this
    // sweep those bytes are invisible and unreclaimable forever.
    const bucket = new MemoryBucket()
    const store = new WorkspaceStore(bucket)
    await bucket.writeMeta(`${TRASH_PREFIX}${newTrashId()}/files/Orphan.md`, '# Orphan\n')

    equal((await store.listTrash()).length, 0, 'an orphan should not appear as a restorable entry')
    const purged = await store.purgeTrash({ now: Date.now() })
    equal(purged.purged.length, 1, 'the orphan was not swept')
  })

  await check('trash keys survive the filesystem backend', async () => {
    // Entry ids become directory names under FsBucket, so anything illegal in a
    // Windows path — a colon from an ISO timestamp, most obviously — breaks delete
    // entirely on one backend and nowhere else.
    const { store, dir } = fsStore()
    await store.write('Notes/Doc.md', '# Doc\n')
    const { trashId } = await store.remove('Notes/Doc.md')
    assert(trashId && !/[:*?"<>|]/.test(trashId), `trash id is not filesystem-safe: ${trashId}`)

    const trashDir = path.join(dir, '.trash')
    assert(fs.existsSync(trashDir), 'nothing was written to the trash directory')

    const restored = await store.restoreFromTrash(trashId!)
    equal(restored.restored, ['Notes/Doc.md'], 'restore failed on the filesystem backend')
    assert(fs.existsSync(path.join(dir, 'notes', 'Notes/Doc.md')), 'the file is not back on disk')
  })

  await check('the trash is not part of the corpus keyspace', async () => {
    const bucket = new MemoryBucket()
    const store = new WorkspaceStore(bucket)
    await store.write('Secret.md', '# Secret\n')
    await store.remove('Secret.md')

    equal(await bucket.listKeys(), [], 'a trashed document is still listed as a corpus key')
    assert((await bucket.listMeta(TRASH_PREFIX)).length > 0, 'the trash namespace is empty')
  })

  console.log('\n1.1 — trash key handling')

  await check('entry file keys round-trip', () => {
    const parsed = parseEntryFileKey(`${TRASH_PREFIX}abc-123/files/Deep/Folder/Note.md`)
    equal(parsed, { id: 'abc-123', path: 'Deep/Folder/Note.md' }, 'key did not parse back')
  })

  await check('a manifest key is not mistaken for a file key', () => {
    equal(parseEntryFileKey(`${TRASH_PREFIX}abc-123/entry.json`), null, 'the manifest parsed as a document')
  })

  await check('an unparseable deletion date counts as expired', () => {
    // Otherwise a corrupt manifest is an entry nothing can ever clear.
    const entry = { id: 'x', kind: 'document' as const, path: 'a.md', label: 'a.md', deletedAt: 'not a date', files: [] }
    assert(isExpired(entry, Date.now()), 'a corrupt entry would be immortal')
  })

  await check('trash ids sort in deletion order', () => {
    const first = newTrashId(1_000_000_000_000)
    const second = newTrashId(1_000_000_001_000)
    assert(first < second, `ids do not sort chronologically: ${first} vs ${second}`)
  })

  console.log('\n1.4 — concurrent index updates')

  await check('two stores over one bucket do not drop each other’s entries', async () => {
    // The exact failure being closed: both read the same index, both patch a
    // different document in, and the second write erases the first one's addition.
    const bucket = new MemoryBucket()
    const a = new WorkspaceStore(bucket)
    const b = new WorkspaceStore(bucket)

    const writes: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      writes.push(a.write(`A${i}.md`, `# A${i}\n`))
      writes.push(b.write(`B${i}.md`, `# B${i}\n`))
    }
    await Promise.all(writes)

    const index = await a.getIndex()
    equal(documentPaths(index).length, 20, 'the index lost documents to a concurrent write')

    const rebuilt = await a.reindex()
    equal(documentPaths(index), documentPaths(rebuilt), 'the patched index disagrees with a rebuild')
  })

  await check('concurrent deletes and writes still converge with a rebuild', async () => {
    const bucket = new MemoryBucket()
    const a = new WorkspaceStore(bucket)
    const b = new WorkspaceStore(bucket)

    for (let i = 0; i < 6; i++) await a.write(`Doc${i}.md`, `# Doc${i}\n`)

    await Promise.all([
      a.remove('Doc0.md'),
      b.write('Doc6.md', '# Doc6\n'),
      a.remove('Doc1.md'),
      b.write('Doc7.md', '# Doc7\n'),
      b.createDirectory('Empty'),
    ])

    const patched = documentPaths(await a.getIndex())
    const rebuilt = documentPaths(await a.reindex())
    equal(patched, rebuilt, 'incremental patches and a rebuild disagree')
    equal(patched, ['Doc2.md', 'Doc3.md', 'Doc4.md', 'Doc5.md', 'Doc6.md', 'Doc7.md'], 'wrong surviving set')
  })

  await check('compare-and-set refuses a stale write', async () => {
    const bucket = new MemoryBucket()
    await bucket.writeMeta('probe.json', 'first')

    equal(await bucket.writeMetaIfUnchanged('probe.json', 'second', 'first'), true, 'a current write was refused')
    equal(await bucket.writeMetaIfUnchanged('probe.json', 'third', 'first'), false, 'a stale write was accepted')
    equal(await bucket.readMeta('probe.json'), 'second', 'the stale write landed anyway')
  })

  await check('compare-and-set treats null as must-not-exist', async () => {
    const bucket = new MemoryBucket()
    equal(await bucket.writeMetaIfUnchanged('fresh.json', 'a', null), true, 'creating a new object was refused')
    equal(await bucket.writeMetaIfUnchanged('fresh.json', 'b', null), false, 'create-only overwrote an existing object')
  })

  console.log('\n1.5 — conflict files')

  await check('a refused save preserves the rejected content', async () => {
    const store = memoryStore()
    const first = await store.write('Note.md', '# Note\n\nversion one\n')

    // Somebody else saves, so the etag the editor is holding goes stale.
    await store.write('Note.md', '# Note\n\nversion two\n')

    const err = await store
      .write('Note.md', '# Note\n\nversion three, typed for an hour\n', { ifMatch: first.etag })
      .then(() => null, (e: unknown) => e as ConflictError)

    assert(err instanceof ConflictError, 'the stale write was not refused')
    assert(err.conflictPath, 'the rejected content was not preserved anywhere')
    equal(err.conflictPath, 'Note.conflict.md', 'unexpected conflict path')

    const live = await store.readDocument('Note.md')
    assert(live!.raw.includes('version two'), 'the refused write clobbered the live document')

    const conflict = await store.readDocument('Note.conflict.md')
    assert(conflict, 'the conflict copy does not exist')
    assert(conflict!.raw.includes('typed for an hour'), 'the conflict copy lost the rejected content')

    const index = await store.getIndex()
    assert(index.documents['Note.conflict.md'], 'the conflict copy is not in the index — nobody would find it')
  })

  await check('a second conflict does not overwrite the first', async () => {
    const store = memoryStore()
    const first = await store.write('Note.md', '# Note\n\none\n')
    await store.write('Note.md', '# Note\n\ntwo\n')

    const a = await store.write('Note.md', 'A\n', { ifMatch: first.etag }).catch((e: ConflictError) => e)
    const b = await store.write('Note.md', 'B\n', { ifMatch: first.etag }).catch((e: ConflictError) => e)

    equal((a as ConflictError).conflictPath, 'Note.conflict.md', 'first conflict path wrong')
    equal((b as ConflictError).conflictPath, 'Note.conflict-2.md', 'second conflict overwrote the first')
    assert((await store.readDocument('Note.conflict.md'))!.raw.includes('A'), 'the first conflict copy was lost')
  })

  await check('a document deleted elsewhere still preserves the save', async () => {
    const store = memoryStore()
    const first = await store.write('Note.md', '# Note\n')
    await store.remove('Note.md')

    const err = await store
      .write('Note.md', '# Note\n\nedits made while it was being deleted\n', { ifMatch: first.etag })
      .then(() => null, (e: unknown) => e as ConflictError)

    assert(err instanceof ConflictError, 'writing over a deleted document was not refused')
    assert(err.conflictPath, 'the work was lost when the document vanished')
  })

  await check('creating a file that already exists writes no conflict copy', async () => {
    // Nothing has been lost here — the caller picked a name that is taken — and a
    // conflict copy would litter the corpus on every duplicate-name attempt.
    const store = memoryStore()
    await store.write('Note.md', '# Note\n')

    const err = await store
      .write('Note.md', '# Note\n', { ifMatch: '*none*' })
      .then(() => null, (e: unknown) => e as ConflictError)

    assert(err instanceof ConflictError, 'a create-only collision was not refused')
    equal(err.conflictPath, undefined, 'a create-only collision wrote a conflict copy')
  })

  await check('a stale etag over identical content writes no conflict copy', async () => {
    // The refusal is still correct — the caller is holding an etag the file has moved
    // past — but the bytes it was refused are the bytes already on storage. There is
    // nothing to rescue, and a copy of the document beside itself is the most
    // confusing way possible to report that.
    const store = memoryStore()
    const first = await store.write('Note.md', '# Note\n\none\n')
    const second = await store.write('Note.md', '# Note\n\ntwo\n')

    const err = await store
      .write('Note.md', second.content ?? '# Note\n\ntwo\n', { ifMatch: first.etag })
      .then(() => null, (e: unknown) => e as ConflictError)

    assert(err instanceof ConflictError, 'the stale write was not refused')
    equal(err.conflictPath, undefined, 'an identical-content refusal wrote a conflict copy')

    const index = await store.getIndex()
    equal(index.documents['Note.conflict.md'], undefined, 'the corpus grew a needless document')
  })

  await check('repeating a refused save reuses its conflict copy', async () => {
    // An autosave that keeps retrying against a stale etag is refused every time. A
    // numbered copy per attempt buries the one copy that matters under duplicates of
    // itself, which is the opposite of preserving it.
    const store = memoryStore()
    const first = await store.write('Note.md', '# Note\n\none\n')
    await store.write('Note.md', '# Note\n\ntwo\n')

    const refuse = () =>
      store
        .write('Note.md', 'unsaved work\n', { ifMatch: first.etag })
        .then(() => null, (e: unknown) => e as ConflictError)

    const a = await refuse()
    const b = await refuse()
    const c = await refuse()

    equal((a as ConflictError).conflictPath, 'Note.conflict.md', 'first conflict path wrong')
    equal((b as ConflictError).conflictPath, 'Note.conflict.md', 'a repeat wrote a second copy of the same text')
    equal((c as ConflictError).conflictPath, 'Note.conflict.md', 'a repeat wrote a third copy of the same text')

    const index = await store.getIndex()
    equal(index.documents['Note.conflict-2.md'], undefined, 'a duplicate conflict copy reached the index')
  })

  await check('conflict copies are ordinary Markdown files', async () => {
    // They have to open in vim, in Obsidian, and in this app. No sidecar format.
    const { store, notes } = fsStore()
    const first = await store.write('Note.md', '# Note\n\none\n')
    await store.write('Note.md', '# Note\n\ntwo\n')
    await store.write('Note.md', '# Note\n\nthree\n', { ifMatch: first.etag }).catch(() => undefined)

    const onDisk = path.join(notes, 'Note.conflict.md')
    assert(fs.existsSync(onDisk), 'the conflict copy is not a file on disk')
    assert(fs.readFileSync(onDisk, 'utf-8').includes('three'), 'the conflict copy has the wrong content')
  })

  console.log('')
  for (const fn of cleanups) fn()

  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

export const runDataSafetyTests = run

if (require.main === module) {
  run().then((ok) => process.exit(ok ? 0 : 1))
}
