import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MemoryBucket, type Bucket } from '../lib/server/bucket'
import { FsBucket } from '../lib/server/fs-bucket'
import { R2Bucket, r2ConfigFromEnv, resolveEndpoint } from '../lib/server/r2-bucket'
import { WorkspaceStore, computeEtag } from '../lib/server/workspace-store'
import type { WorkspaceIndex } from '../lib/file-store'

/**
 * Backend conformance suite.
 *
 * The reason the storage layer was split out at all: one implementation of the
 * rules, many backends that only move bytes. That claim is worth exactly as much as
 * the evidence for it, so this runs an identical scenario against every backend and
 * requires the resulting index to be byte-identical.
 *
 * If it ever diverges, the "index is disposable" promise is broken on at least one
 * backend, and a link someone was sent stops resolving after a reindex.
 *
 * R2 runs only when credentials are present. Without them it is reported as skipped
 * rather than silently passing — a green suite that never touched the backend it
 * claims to cover is worse than a red one.
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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

/**
 * The scenario every backend must agree on.
 *
 * Deliberately exercises the operations where backends differ most: folders (which
 * object storage does not have), moves (which have no atomic form), and deletes that
 * leave an empty folder behind.
 */
async function runScenario(store: WorkspaceStore): Promise<WorkspaceIndex> {
  await store.write('Alpha.md', '# Alpha\n\nLinks to [[Beta]] and [[Gamma]].\n')
  await store.write('Notes/Beta.md', '# Beta\n\nBack to [[Alpha]].\n')
  await store.write('Notes/Deep/Gamma.md', '# Gamma\n\nSee [[Beta]].\n')

  await store.createDirectory('Empty/Nested')

  await store.move('Notes/Beta.md', 'Notes/Beta Renamed.md')
  await store.moveDirectory('Notes/Deep', 'Archive')
  await store.write('Archive/Gamma.md', '# Gamma\n\nEdited after the move.\n', {})
  await store.remove('Alpha.md')

  return store.getIndex()
}

/**
 * The parts of an index two backends must agree on.
 *
 * `etag` and `id` are excluded, and the exclusion is the point rather than a
 * loophole: R7 assigns a random id on first save, that id lives in frontmatter, and
 * the etag is a hash of the whole file. Two independent runs therefore produce
 * different ids and different etags *by design*, on any backend.
 *
 * The etag path is not left untested — `etagsDescribeStoredBytes` below asserts per
 * backend that every etag is the hash of what is actually in storage, which is the
 * property that matters.
 */
function comparable(index: WorkspaceIndex): unknown {
  return {
    documents: Object.fromEntries(
      Object.entries(index.documents)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, doc]) => [
          key,
          {
            path: doc.path,
            title: doc.title,
            content: doc.content,
            outboundLinks: doc.outboundLinks,
            aliases: doc.aliases ?? null,
          },
        ])
    ),
    tree: index.tree,
    backlinks: Object.fromEntries(
      Object.entries(index.backlinks)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, sources]) => [key, [...sources].sort()])
    ),
  }
}

function makeFsBucket(): Bucket {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-backend-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return new FsBucket({
    notesDir: path.join(dir, 'notes'),
    indexPath: path.join(dir, 'index.json'),
    metaDir: dir,
  })
}

/**
 * Endpoint resolution.
 *
 * Every case here is a configuration that previously failed at the TLS or signature
 * layer, far from its cause. The path-style assertion covers a real outage: without
 * it the SDK dials `<bucket>.<account>.r2.cloudflarestorage.com`, which Cloudflare's
 * single-label wildcard certificate does not cover, and every request dies with
 * `EPROTO … alert number 40`.
 */
async function endpointChecks() {
  console.log('R2 endpoint resolution')

  await check('derives the endpoint from an account id', () => {
    equal(
      resolveEndpoint({ accountId: 'abc123' }),
      'https://abc123.r2.cloudflarestorage.com',
      'wrong endpoint'
    )
  })

  await check('honours the EU jurisdiction', () => {
    equal(
      resolveEndpoint({ accountId: 'abc123', jurisdiction: 'eu' }),
      'https://abc123.eu.r2.cloudflarestorage.com',
      'EU buckets need their own host or the handshake fails'
    )
  })

  await check('an explicit endpoint is reduced to its origin', () => {
    equal(
      resolveEndpoint({ explicit: 'https://abc123.r2.cloudflarestorage.com' }),
      'https://abc123.r2.cloudflarestorage.com',
      'origin changed'
    )
  })

  await check('rejects an endpoint with the bucket appended', () => {
    // The Cloudflare dashboard shows an "S3 API" URL ending in the bucket name.
    // Pasting it whole sends every request to /<bucket>/<bucket>/<key>.
    let threw = false
    try {
      resolveEndpoint({ explicit: 'https://abc123.r2.cloudflarestorage.com/my-bucket' })
    } catch (err) {
      threw = true
      assert((err as Error).message.includes('must not include a path'), 'unhelpful message')
    }
    assert(threw, 'an endpoint with a path should be refused')
  })

  await check('rejects a URL pasted into R2_ACCOUNT_ID', () => {
    let threw = false
    try {
      resolveEndpoint({ accountId: 'https://abc123.r2.cloudflarestorage.com' })
    } catch (err) {
      threw = true
      assert((err as Error).message.includes('looks like a URL'), 'unhelpful message')
    }
    assert(threw, 'a URL in the account id should be refused')
  })

  await check('rejects a malformed endpoint', () => {
    let threw = false
    try {
      resolveEndpoint({ explicit: 'not a url' })
    } catch {
      threw = true
    }
    assert(threw, 'a malformed endpoint should be refused')
  })

  await check('requires an account id when no endpoint is given', () => {
    let threw = false
    try {
      resolveEndpoint({})
    } catch {
      threw = true
    }
    assert(threw, 'should refuse to guess')
  })

  await check('R2 uses path style, so the wildcard certificate matches', () => {
    // Guards the outage directly: virtual-hosted style puts the bucket in the
    // hostname, and *.r2.cloudflarestorage.com covers only one label.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'lib', 'server', 'r2-bucket.ts'),
      'utf-8'
    )
    assert(
      /forcePathStyle:\s*true/.test(source),
      'forcePathStyle must stay true — without it every R2 request fails the TLS handshake'
    )
  })

  console.log('')
}

async function run() {
  console.log('Backend conformance suite\n')

  await endpointChecks()

  const backends: Array<{ name: string; make: () => Bucket }> = [
    { name: 'memory', make: () => new MemoryBucket() },
    { name: 'filesystem', make: makeFsBucket },
  ]

  if (r2ConfigFromEnv()) {
    /**
     * Namespace BOTH prefixes, and clean up.
     *
     * This ran against the real bucket with only `documentPrefix` set, which
     * isolates the documents and nothing else: `_meta` is shared across every prefix
     * in a bucket, so the scenario's index was written straight over the live one and
     * its deleted fixture landed in the live trash. The corpus was never in danger —
     * the index is derived — but the deployment showed three documents that do not
     * exist until someone reindexed.
     *
     * Isolating documents without isolating metadata is the trap. Both, or neither.
     */
    const prefix = `conformance-${Date.now()}`
    const make = () => new R2Bucket({ documentPrefix: prefix, metaPrefix: `${prefix}/_meta` })

    backends.push({ name: 'r2', make })
    cleanups.push(() => {
      // Fire-and-forget: cleanups run synchronously at the end of the suite, and a
      // failure to tidy must not fail a run that otherwise passed. The prefix is
      // timestamped, so leftovers are inert and identifiable.
      const bucket = make()
      void bucket
        .deleteFolder('')
        .then(async () => {
          for (const key of await bucket.listMeta('')) await bucket.deleteMeta(key)
        })
        .catch((err: Error) => console.error(`  ! could not remove ${prefix}: ${err.message}`))
    })
  }

  console.log(`backends under test: ${backends.map((b) => b.name).join(', ')}`)
  if (!r2ConfigFromEnv()) {
    console.log('  ! r2 SKIPPED — no credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,')
    console.log('    R2_SECRET_ACCESS_KEY and R2_BUCKET to include it.')
  }
  console.log('')

  const results = new Map<string, unknown>()

  for (const backend of backends) {
    console.log(`${backend.name}`)
    const store = new WorkspaceStore(backend.make())

    await check(`${backend.name}: the scenario runs end to end`, async () => {
      const index = await runScenario(store)
      results.set(backend.name, comparable(index))

      assert(index.documents['Notes/Beta Renamed.md'], 'renamed document missing')
      assert(index.documents['Archive/Gamma.md'], 'moved document missing')
      assert(!index.documents['Alpha.md'], 'deleted document still indexed')
      assert(!index.documents['Notes/Deep/Gamma.md'], 'pre-move key still indexed')
    })

    await check(`${backend.name}: an empty folder survives`, async () => {
      const index = await store.getIndex()
      const empty = index.tree.find((n) => n.isDir && n.path === 'Empty')
      assert(empty, 'the empty folder was dropped from the tree')
      assert(
        empty!.children?.some((n) => n.path === 'Empty/Nested'),
        'the nested empty folder was dropped'
      )
    })

    await check(`${backend.name}: a folder outlives its last document`, async () => {
      const index = await store.getIndex()
      assert(
        index.tree.some((n) => n.isDir && n.path === 'Notes'),
        'the folder vanished when its documents moved away'
      )
    })

    await check(`${backend.name}: every etag is the hash of what is in storage`, async () => {
      const index = await store.getIndex()
      for (const [key, doc] of Object.entries(index.documents)) {
        const stored = await store.bucket.readText(key)
        assert(stored !== null, `${key} is indexed but not in storage`)
        equal(doc.etag, computeEtag(stored!), `etag for ${key} does not describe the stored bytes`)
      }
    })

    await check(`${backend.name}: reindex from storage alone matches the patched index`, async () => {
      // The Sprint 5 drill. Nothing in reindex() reads the existing index.
      const before = comparable(await store.getIndex())
      const after = comparable(await store.reindex())
      equal(after, before, 'a rebuild disagreed with the incrementally-patched index')
    })

    console.log('')
  }

  console.log('cross-backend agreement')
  const names = Array.from(results.keys())
  const [first, ...rest] = names

  for (const other of rest) {
    await check(`${first} and ${other} produce an identical index`, () => {
      equal(results.get(other), results.get(first), `${other} diverged from ${first}`)
    })
  }

  if (rest.length === 0) {
    console.log('  ! only one backend ran — nothing to compare')
  }

  console.log('')
  for (const done of cleanups) done()

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

export { run as runBackendTests }
