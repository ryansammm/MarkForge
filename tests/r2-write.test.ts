import { R2Bucket } from '../lib/server/r2-bucket'
import { WorkspaceStore, computeEtag } from '../lib/server/workspace-store'
import { ConflictError } from '../lib/file-store'

/**
 * R2 write-path suite (production-readiness plan, item 1.3 — blocker B2).
 *
 * Reads against R2 are proven by the app running. Writes are not, and writes are the
 * operations that can lose something. Everything here exists because it can only fail
 * against a real service:
 *
 *   - **Conditional PUT.** `writeMetaIfUnchanged` is the whole of item 1.4's
 *     guarantee, and it rests on R2 honouring `If-Match` / `If-None-Match` the way
 *     the code believes. If that belief is wrong, every index write fails five times
 *     and then throws — in production, on the deployment target, after the document
 *     has already been written. No local backend can catch that.
 *   - **Key handling.** Spaces and non-ASCII in keys are signed and URL-encoded by
 *     the SDK. `MemoryBucket` has no opinion about either.
 *   - **Size.** A >1MB document crosses the boundary where a body stops being one
 *     buffered chunk.
 *
 * It is **opt-in and points at a scratch bucket on purpose**: `R2_TEST_BUCKET`, never
 * `R2_BUCKET`. This suite writes and deletes; a stray environment variable must not
 * be able to aim it at a real corpus. Without it the suite reports skipped rather
 * than passing, because a green run that touched nothing is worse than a red one.
 *
 *   R2_TEST_BUCKET=scratch npm run test:r2
 */

let passed = 0
let skipped = false
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

export async function runR2WriteTests(): Promise<boolean> {
  console.log('R2 write-path suite\n')

  const bucketName = process.env.R2_TEST_BUCKET
  if (!bucketName) {
    console.log('  SKIPPED — set R2_TEST_BUCKET (a scratch bucket, not your corpus) to run this.\n')
    skipped = true
    return true
  }

  // Every run gets its own prefix, so a crashed run cannot poison the next one and
  // two people can run this at the same time.
  const prefix = `_test/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // Both prefixes, always. `_meta` is shared across a bucket, so isolating documents
  // alone would let this suite write its index over whatever else is in there.
  //
  // Siblings, not nested — the arrangement a deployment actually uses (`notes` and
  // `_meta` at the bucket root). Nesting metadata inside the document prefix puts
  // trashed `.md` files back inside the corpus keyspace, so `listKeys` would return
  // them and the suite would be proving something no deployment does.
  const scoped = {
    bucket: bucketName,
    documentPrefix: `${prefix}/notes`,
    metaPrefix: `${prefix}/_meta`,
  }
  const bucket = new R2Bucket(scoped)
  const store = new WorkspaceStore(bucket)

  console.log(`  bucket: ${bucketName}`)
  console.log(`  prefix: ${prefix}\n`)

  try {
    console.log('documents')

    await check('a document written to R2 reads back byte-identical', async () => {
      const body = '---\ntitle: Round Trip\n---\n\n# Round Trip\n\nWith a [[Link]].\n'
      const result = await store.write('Round Trip.md', body)
      const back = await store.readDocument('Round Trip.md')
      assert(back, 'the document did not come back')
      equal(back!.raw, result.content ?? body, 'bytes differ after a round trip through R2')
      equal(computeEtag(back!.raw), result.etag, 'etag does not describe what R2 holds')
    })

    await check('keys with spaces and non-ASCII survive signing', async () => {
      // These are signed and percent-encoded by the SDK. Getting it wrong produces a
      // SignatureDoesNotMatch that no local backend can reproduce.
      const key = 'Ärchiv/Notas de reunião — 2026.md'
      await store.write(key, '# Reunião\n')
      const back = await store.readDocument(key)
      assert(back, 'a non-ASCII key did not read back')
      assert((await bucket.listKeys()).includes(key), 'the key is missing from a listing')
    })

    await check('a document over 1MB writes and reads back whole', async () => {
      const body = `# Big\n\n${'x'.repeat(1024 * 1024 + 17)}\n`
      const result = await store.write('Big.md', body)

      // Compared against what was *written*, not what was sent. The first save
      // injects a frontmatter id (R7), so the file is ~30 bytes longer than the
      // submission — which an earlier version of this check reported as truncation.
      const written = result.content ?? body

      const back = await store.readDocument('Big.md')
      assert(back, 'the large document did not come back')
      equal(back!.raw.length, written.length, 'the large document was truncated')
      assert(back!.raw.endsWith('x\n'), 'the tail of the large document is missing')
      equal(computeEtag(back!.raw), result.etag, 'etag does not describe what R2 holds')
    })

    await check('If-Match is enforced against a real etag', async () => {
      const first = await store.write('Guarded.md', '# One\n')
      await store.write('Guarded.md', '# Two\n')

      const err = await store
        .write('Guarded.md', '# Three\n', { ifMatch: first.etag })
        .then(() => null, (e: unknown) => e as ConflictError)

      assert(err instanceof ConflictError, 'a stale write was accepted')
      assert(err.conflictPath, 'no conflict copy was written')
      const live = await store.readDocument('Guarded.md')
      assert(live!.raw.includes('Two'), 'the stale write clobbered the live document')
    })

    console.log('\nconditional writes — the basis of cross-instance safety')

    await check('a conditional write on unchanged metadata succeeds', async () => {
      await bucket.writeMeta('cas-probe.json', 'one')
      const current = await bucket.readMeta('cas-probe.json')
      equal(await bucket.writeMetaIfUnchanged('cas-probe.json', 'two', current), true, 'R2 refused a valid If-Match')
      equal(await bucket.readMeta('cas-probe.json'), 'two', 'the write did not land')
    })

    await check('a conditional write on stale metadata is refused', async () => {
      // If this passes rather than returning false, R2 is not honouring If-Match and
      // item 1.4 provides no protection at all on the deployment target.
      await bucket.writeMeta('cas-probe.json', 'current')
      equal(
        await bucket.writeMetaIfUnchanged('cas-probe.json', 'clobber', 'stale'),
        false,
        'R2 accepted a write whose If-Match precondition was wrong'
      )
      equal(await bucket.readMeta('cas-probe.json'), 'current', 'the stale write landed anyway')
    })

    await check('a conditional write survives a cold cache', async () => {
      // A second client has never read the object, so it has no remembered etag and
      // falls back to computing one. That fallback is what a serverless cold start
      // does on every request.
      await bucket.writeMeta('cas-cold.json', 'body-a')
      const cold = new R2Bucket(scoped)
      equal(
        await cold.writeMetaIfUnchanged('cas-cold.json', 'body-b', 'body-a'),
        true,
        'the cold-start fallback could not name the current etag'
      )
    })

    await check('metadata is isolated by prefix, not shared across the bucket', async () => {
      // The regression this exists for: `_meta` used to be a single namespace for the
      // whole bucket, so a suite that scoped only its documents wrote its index over
      // the live one. Scoping documents without scoping metadata isolates nothing
      // that matters.
      const neighbour = new R2Bucket({
        bucket: bucketName,
        documentPrefix: `${prefix}/neighbour/notes`,
        metaPrefix: `${prefix}/neighbour/_meta`,
      })

      // A probe key, NOT `index.json`. Writing to the real one clobbered this
      // suite's own live index with a stub, after which every later patch was
      // applied to an empty index — and the reindex check at the end reported the
      // damage as a disagreement, which read like a bug in reindex. Isolation is
      // demonstrated by any key.
      const probe = 'isolation-probe.json'

      await bucket.writeMeta(probe, '{"mine":true}')
      await neighbour.writeMeta(probe, '{"mine":false}')

      equal(await bucket.readMeta(probe), '{"mine":true}', 'a neighbouring prefix overwrote our metadata')
      equal(await neighbour.listMeta(''), [probe], 'a neighbouring prefix can see our metadata')

      await bucket.deleteMeta(probe)
      await neighbour.deleteMeta(probe)
    })

    await check('create-only refuses to overwrite', async () => {
      const name = `cas-create-${Date.now().toString(36)}.json`
      equal(await bucket.writeMetaIfUnchanged(name, 'first', null), true, 'creating a new object failed')
      equal(await bucket.writeMetaIfUnchanged(name, 'second', null), false, 'create-only overwrote an object')
      await bucket.deleteMeta(name)
    })

    await check('two stores over one real bucket do not lose index entries', async () => {
      const racing = {
        bucket: bucketName,
        documentPrefix: `${prefix}/race/notes`,
        metaPrefix: `${prefix}/race/_meta`,
      }
      const a = new WorkspaceStore(new R2Bucket(racing))
      const b = new WorkspaceStore(new R2Bucket(racing))

      await Promise.all([
        a.write('A1.md', '# A1\n'),
        b.write('B1.md', '# B1\n'),
        a.write('A2.md', '# A2\n'),
        b.write('B2.md', '# B2\n'),
      ])

      const index = await a.getIndex()
      equal(Object.keys(index.documents).sort(), ['A1.md', 'A2.md', 'B1.md', 'B2.md'], 'the index lost a concurrent write')
    })

    console.log('\nfolders, trash and deletion')

    await check('an empty folder survives, and its marker is not a document', async () => {
      await store.createDirectory('Empty Folder')
      assert(await bucket.folderExists('Empty Folder'), 'the folder does not exist')
      assert(
        !(await bucket.listKeys()).some((key) => key.endsWith('.keep')),
        'a folder marker leaked into the corpus listing'
      )
    })

    await check('deleting on R2 fills the trash and restores from it', async () => {
      await store.write('Trashable.md', '# Trashable\n\nvaluable\n')
      const { trashId } = await store.remove('Trashable.md')
      assert(trashId, 'no trash entry was created on R2')

      equal(await store.getFile('Trashable.md'), null, 'the document is still readable')
      assert(
        !(await bucket.listKeys()).includes('Trashable.md'),
        'a trashed document is still in the corpus keyspace'
      )

      const result = await store.restoreFromTrash(trashId!)
      equal(result.restored, ['Trashable.md'], 'the restore failed on R2')
      const back = await store.readDocument('Trashable.md')
      assert(back!.raw.includes('valuable'), 'the restored content is wrong')
    })

    await check('a reindex from R2 alone matches the patched index', async () => {
      const patched = Object.keys((await store.getIndex()).documents).sort()
      const rebuilt = Object.keys((await store.reindex()).documents).sort()

      // Named rather than expected/actual. When this failed, the generic wording
      // made it read as "reindex found one document" when the truth was the
      // opposite — reindex was right and the patched index had been clobbered.
      // Which side is wrong is the whole diagnosis, so the message says it.
      if (JSON.stringify(patched) !== JSON.stringify(rebuilt)) {
        throw new Error(
          'the patched index and a rebuild from R2 disagree\n' +
            `      patched (incremental): ${JSON.stringify(patched)}\n` +
            `      rebuilt (from R2):     ${JSON.stringify(rebuilt)}`
        )
      }
      assert(rebuilt.length > 1, `a rebuild from R2 found only ${JSON.stringify(rebuilt)}`)
    })
  } finally {
    // Leaving scratch objects behind in someone's bucket is its own small failure.
    console.log('\n  cleaning up…')
    try {
      await bucket.deleteFolder('')
      for (const key of await bucket.listMeta('')) await bucket.deleteMeta(key)
    } catch (err) {
      console.error(`  ! cleanup failed, remove ${prefix} by hand: ${(err as Error).message}`)
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
  runR2WriteTests().then((ok) => {
    if (skipped) process.exit(0)
    process.exit(ok ? 0 : 1)
  })
}
