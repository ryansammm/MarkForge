import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WorkspaceStore, computeEtag } from '../lib/server/workspace-store'
import { FsBucket } from '../lib/server/fs-bucket'
import { ConflictError, CREATE_ONLY, InvalidPathError, NotFoundError, type WorkspaceIndex } from '../lib/file-store'
import { ingestDirectory } from '../scripts/ingest'

/**
 * FileStore write-path suite.
 *
 * Covers Sprint 3 DoD items 3, 4 and 5:
 *   - a file hand-edited in another editor opens correctly on next load
 *   - a failed save never lands (the editor's buffer is what survives, tested in UI)
 *   - index.json stays consistent after 50 consecutive edits
 *
 * The 50-edit check is the strong one: after the edits it runs a full reindex from
 * the bucket alone and demands the incrementally-patched index match it exactly.
 * That is Sprint 5's reindex drill, run early and cheaply.
 */

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        passed++
        console.log(`  ok  ${name}`)
      },
      (err: Error) => {
        failures.push(`${name}\n      ${err.message}`)
        console.error(`  FAIL ${name}`)
        console.error(`       ${err.message}`)
      }
    )
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`)
}

async function expectThrows<T extends Error>(
  fn: () => Promise<unknown>,
  type: new (...args: never[]) => T,
  message: string
): Promise<T> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof type) return err
    throw new Error(`${message} — threw ${(err as Error).name} instead`)
  }
  throw new Error(`${message} — did not throw`)
}

interface Workspace {
  dir: string
  notes: string
  indexPath: string
  store: WorkspaceStore
}

function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-test-'))
  const notes = path.join(dir, 'notes')
  const indexPath = path.join(dir, 'index.json')
  fs.mkdirSync(notes, { recursive: true })
  return {
    dir,
    notes,
    indexPath,
    // metaDir matters: without it the trash lands in process.cwd(), so a test that
    // deletes a document writes into the repository it is testing.
    store: new WorkspaceStore(new FsBucket({ notesDir: notes, metaDir: dir, indexPath })),
  }
}

function cleanup(ws: Workspace) {
  fs.rmSync(ws.dir, { recursive: true, force: true })
}

function readIndex(ws: Workspace): WorkspaceIndex {
  return JSON.parse(fs.readFileSync(ws.indexPath, 'utf-8')) as WorkspaceIndex
}

function readFileRaw(ws: Workspace, relative: string): string {
  return fs.readFileSync(path.join(ws.notes, relative), 'utf-8')
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('FileStore write-path suite\n')

  console.log('writes and etags')
  {
    const ws = makeWorkspace()
    try {
      await check('write creates the file and the index entry', async () => {
        const result = await ws.store.write('Notes/First.md', '# First\n\nSee [[Second]].\n')
        assert(fs.existsSync(path.join(ws.notes, 'Notes/First.md')), 'file not on disk')

        const index = readIndex(ws)
        assert(index.documents['Notes/First.md'], 'no index entry')
        equal(index.documents['Notes/First.md'].title, 'First', 'title not derived from H1')
        equal(index.documents['Notes/First.md'].outboundLinks, ['Second'], 'outbound links wrong')
        equal(index.backlinks['Second'], ['Notes/First.md'], 'backlink not recorded')

        // Since Sprint 4 the first save assigns an id (R7), so the bytes written are
        // not the bytes sent. The etag must describe what actually landed on disk,
        // or the caller's next If-Match would fail against its own write.
        assert(result.content, 'id injection should be reported back to the caller')
        equal(result.etag, computeEtag(result.content!), 'etag does not describe the written bytes')
        equal(result.etag, computeEtag(readFileRaw(ws, 'Notes/First.md')), 'etag disagrees with disk')
        assert(result.document.id, 'no id assigned on first save')
      })

      await check('If-Match with the current etag is accepted', async () => {
        const current = await ws.store.getFile('Notes/First.md')
        assert(current?.etag, 'no etag on read')
        await ws.store.write('Notes/First.md', '# First\n\nEdited.\n', { ifMatch: current.etag })
        const after = await ws.store.getFile('Notes/First.md')
        assert(after?.content?.includes('Edited.'), 'edit did not land')
      })

      await check('If-Match with a stale etag is refused', async () => {
        const err = await expectThrows(
          () => ws.store.write('Notes/First.md', 'clobber\n', { ifMatch: 'deadbeef' }),
          ConflictError,
          'stale If-Match should conflict'
        )
        equal(err.expectedEtag, 'deadbeef', 'expected etag not reported')
        assert(err.actualEtag, 'actual etag not reported')

        const onDisk = fs.readFileSync(path.join(ws.notes, 'Notes/First.md'), 'utf-8')
        assert(!onDisk.includes('clobber'), 'refused write still touched the file')
      })

      await check('CREATE_ONLY refuses an existing file', async () => {
        await expectThrows(
          () => ws.store.write('Notes/First.md', 'x\n', { ifMatch: CREATE_ONLY }),
          ConflictError,
          'CREATE_ONLY on existing file should conflict'
        )
      })

      await check('CREATE_ONLY accepts a new file', async () => {
        await ws.store.write('Notes/Third.md', '# Third\n', { ifMatch: CREATE_ONLY })
        assert(readIndex(ws).documents['Notes/Third.md'], 'new file not indexed')
      })

      await check('If-Match on a file deleted elsewhere is refused', async () => {
        const doc = await ws.store.getFile('Notes/Third.md')
        fs.unlinkSync(path.join(ws.notes, 'Notes/Third.md'))
        await expectThrows(
          () => ws.store.write('Notes/Third.md', 'y\n', { ifMatch: doc!.etag }),
          ConflictError,
          'write against a vanished file should conflict'
        )
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nreading the file, not the index')
  {
    const ws = makeWorkspace()
    try {
      await check('a file hand-edited on disk opens with the on-disk text', async () => {
        await ws.store.write('Hand.md', '# Hand\n\nvia app\n')

        // Simulate vim: change the file behind the app's back.
        const target = path.join(ws.notes, 'Hand.md')
        fs.writeFileSync(target, '# Hand\n\nvia vim [[Elsewhere]]\n', 'utf-8')

        const doc = await ws.store.getFile('Hand.md')
        assert(doc?.content?.includes('via vim'), 'read served stale index content')
        equal(doc!.outboundLinks, ['Elsewhere'], 'links not reparsed from disk')
        equal(doc!.etag, computeEtag('# Hand\n\nvia vim [[Elsewhere]]\n'), 'etag not from disk')
      })

      await check('reading a document does not restamp it as just updated', async () => {
        /*
          `readDocument` used to set `updatedAt` to the moment of the read, and the
          client patches every read into its index — so opening a note was
          indistinguishable from editing it. The details panel said "Just now" about
          documents nobody had touched in months.

          Back-dated on disk and then read twice, a second apart in wall-clock terms:
          both reads must report the file's own mtime, and neither may report now.
        */
        await ws.store.write('Old News.md', '# Old News\n')

        const backdated = new Date('2019-04-01T10:00:00.000Z')
        fs.utimesSync(path.join(ws.notes, 'Old News.md'), backdated, backdated)

        const first = await ws.store.getFile('Old News.md')
        const second = await ws.store.getFile('Old News.md')

        equal(first?.updatedAt, backdated.toISOString(), 'the read did not report the file mtime')
        equal(second?.updatedAt, first?.updatedAt, 'two reads of one unchanged file disagreed')
      })

      await check('a reindex leaves every document at the time it was last written', async () => {
        // The index is disposable, which means rebuilding it must change nothing a
        // reader can see. Stamping `now` here rewrote the edit history of the corpus.
        await ws.store.write('Ancient.md', '# Ancient\n')
        const backdated = new Date('2020-01-02T03:04:05.000Z')
        fs.utimesSync(path.join(ws.notes, 'Ancient.md'), backdated, backdated)

        const index = await ws.store.reindex()
        equal(
          index.documents['Ancient.md'].updatedAt,
          backdated.toISOString(),
          'the reindex restamped the document'
        )
      })

      await check('the stale etag from before the hand-edit is refused', async () => {
        await ws.store.write('Stale.md', 'one\n')
        const stale = (await ws.store.getFile('Stale.md'))!.etag
        fs.writeFileSync(path.join(ws.notes, 'Stale.md'), 'two\n', 'utf-8')

        await expectThrows(
          () => ws.store.write('Stale.md', 'three\n', { ifMatch: stale }),
          ConflictError,
          'should detect the out-of-band edit'
        )
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nmove and remove')
  {
    const ws = makeWorkspace()
    try {
      await check('move updates path, tree and index', async () => {
        await ws.store.write('a/Old.md', '# Old\n\n[[Target]]\n')
        await ws.store.move('a/Old.md', 'b/New.md')

        const index = readIndex(ws)
        assert(!index.documents['a/Old.md'], 'old entry still present')
        assert(index.documents['b/New.md'], 'new entry missing')
        equal(index.backlinks['Target'], ['b/New.md'], 'backlink not repointed')

        // Since Sprint 4, folders are deliberate objects rather than side effects of
        // a document path, so moving the last document out of one leaves it standing.
        assert(fs.existsSync(path.join(ws.notes, 'a')), 'emptied directory was pruned')
        assert(index.tree.some((n) => n.path === 'a'), 'emptied directory dropped from tree')
      })

      await check('move onto an existing path is refused', async () => {
        await ws.store.write('x.md', 'x\n')
        await ws.store.write('y.md', 'y\n')
        const destinationBefore = readFileRaw(ws, 'y.md')

        await expectThrows(() => ws.store.move('x.md', 'y.md'), ConflictError, 'should refuse overwrite')

        assert(fs.existsSync(path.join(ws.notes, 'x.md')), 'source was removed anyway')
        equal(readFileRaw(ws, 'y.md'), destinationBefore, 'destination was clobbered')
      })

      await check('move of a missing file is a 404, not a conflict', async () => {
        await expectThrows(() => ws.store.move('nope.md', 'z.md'), NotFoundError, 'should be NotFound')
      })

      await check('remove clears documents, tree and backlinks', async () => {
        await ws.store.write('gone/Doc.md', '# Doc\n\n[[Somewhere]]\n')
        await ws.store.remove('gone/Doc.md')

        const index = readIndex(ws)
        assert(!index.documents['gone/Doc.md'], 'entry still present')
        assert(!index.backlinks['Somewhere'], 'backlink not cleared')
        // The folder stays — deleting a document is not deleting its folder.
        // Removing a folder is removeDirectory, and it is always explicit.
        assert(fs.existsSync(path.join(ws.notes, 'gone')), 'directory was pruned')
      })

      await check('remove with a stale etag is refused', async () => {
        await ws.store.write('keep.md', 'keep\n')
        await expectThrows(
          () => ws.store.remove('keep.md', { ifMatch: 'nope' }),
          ConflictError,
          'stale etag should block the delete'
        )
        assert(fs.existsSync(path.join(ws.notes, 'keep.md')), 'file deleted despite conflict')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\npath safety')
  {
    const ws = makeWorkspace()
    try {
      const bad = ['../escape.md', 'a/../../escape.md', '..\\escape.md', 'notes.txt', '', 'a//b.md']
      for (const candidate of bad) {
        await check(`refuses ${JSON.stringify(candidate)}`, async () => {
          await expectThrows(
            () => ws.store.write(candidate, 'x\n'),
            InvalidPathError,
            'should reject'
          )
        })
      }

      // A leading slash means "root of the workspace", not root of the filesystem.
      // It is normalized rather than rejected — the important property is that it
      // cannot land outside the notes directory.
      await check('treats a leading slash as workspace-absolute', async () => {
        const result = await ws.store.write('/etc/passwd.md', 'contained\n')
        equal(result.path, 'etc/passwd.md', 'leading slash not normalized away')
        assert(
          fs.existsSync(path.join(ws.notes, 'etc', 'passwd.md')),
          'file did not land inside the workspace'
        )
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('\nindex consistency under sustained editing')
  {
    const ws = makeWorkspace()
    try {
      await check('50 consecutive edits leave the index equal to a full reindex', async () => {
        const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
        for (const name of names) {
          await ws.store.write(`docs/${name}.md`, `# ${name}\n\nseed\n`)
        }

        for (let i = 0; i < 50; i++) {
          const name = names[i % names.length]
          const link = names[(i + 1) % names.length]
          await ws.store.write(
            `docs/${name}.md`,
            `# ${name}\n\nrevision ${i} linking [[${link}]].\n`
          )
        }

        // Rebuild from the corpus alone and compare.
        const rebuiltPath = path.join(ws.dir, 'rebuilt.json')
        await ingestDirectory(ws.notes, rebuiltPath)
        const rebuilt = JSON.parse(fs.readFileSync(rebuiltPath, 'utf-8')) as WorkspaceIndex
        const incremental = readIndex(ws)

        equal(
          Object.keys(incremental.documents).sort(),
          Object.keys(rebuilt.documents).sort(),
          'document sets diverged'
        )
        equal(incremental.tree, rebuilt.tree, 'trees diverged')

        const normalizeBacklinks = (b: Record<string, string[]>) =>
          Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [...v].sort()]).sort())
        equal(
          normalizeBacklinks(incremental.backlinks),
          normalizeBacklinks(rebuilt.backlinks),
          'backlinks diverged'
        )

        for (const key of Object.keys(rebuilt.documents)) {
          const a = incremental.documents[key]
          const b = rebuilt.documents[key]
          equal(a.title, b.title, `title diverged for ${key}`)
          equal(a.content, b.content, `content diverged for ${key}`)
          equal(a.outboundLinks, b.outboundLinks, `links diverged for ${key}`)
          equal(a.etag, b.etag, `etag diverged for ${key}`)
        }
      })

      await check('concurrent writes all land — none is lost to a read-patch-write race', async () => {
        const writes = Array.from({ length: 20 }, (_, i) =>
          ws.store.write(`race/Doc${i}.md`, `# Doc${i}\n\n[[Shared]]\n`)
        )
        await Promise.all(writes)

        const index = readIndex(ws)
        for (let i = 0; i < 20; i++) {
          assert(index.documents[`race/Doc${i}.md`], `race/Doc${i}.md missing from index`)
        }
        equal(index.backlinks['Shared'].length, 20, 'backlinks lost under concurrency')
      })
    } finally {
      cleanup(ws)
    }
  }

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS — ${passed} checks, 0 failures.`)
    return true
  }
  console.error(`FAIL — ${failures.length} failure(s) of ${passed + failures.length} checks:\n`)
  for (const f of failures) console.error(`  ${f}\n`)
  return false
}

if (require.main === module) {
  run().then((ok) => process.exit(ok ? 0 : 1))
}

export { run as runStoreTests }
