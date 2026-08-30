/**
 * Task 11 self-check: grimoire create without folder picker.
 *
 * Two surfaces:
 *
 *   1. `createGrimoire(bucket, name)` with no opts persists a
 *      registry entry that has no `path`. The folder picker is
 *      gone from the create flow; a grimoire without a root
 *      folder is a normal state, not a stub.
 *   2. `readRegistry` round-trips legacy entries that DO have a
 *      `path` — proving the optional field stays optional and
 *      the new entries coexist with the old.
 *
 * Run with `pnpm tsx scripts/check-grimoire-create.ts`. Exit 0 = pass.
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { FsBucket } from '../lib/server/fs-bucket'
import { createGrimoire, readRegistry } from '../lib/server/grimoire'

const ok: string[] = []
const fail: string[] = []

function assert(name: string, condition: unknown, detail?: string): void {
  ;(condition ? ok : fail).push(detail ? `${name} (${detail})` : name)
}

async function withTempBucket<T>(fn: (bucket: FsBucket, root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markforge-grimoire-check-'))
  const notesDir = path.join(root, 'notes')
  const metaDir = path.join(root, 'meta')
  await fs.mkdir(notesDir, { recursive: true })
  await fs.mkdir(metaDir, { recursive: true })
  try {
    return await fn(new FsBucket({ notesDir, metaDir }), root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  // ---- 1. createGrimoire without path ---------------------------------

  await withTempBucket(async (bucket) => {
    const g = await createGrimoire(bucket, 'Plain')
    assert('createGrimoire: returns an id', typeof g.id === 'string' && g.id.length > 0)
    assert('createGrimoire: returns the given name', g.name === 'Plain')
    assert('createGrimoire: no path on the entry (folder picker dropped)', g.path === undefined)
    assert('createGrimoire: createdAt is set', typeof g.createdAt === 'string' && g.createdAt.length > 0)

    // Re-read the registry; the entry should still be there with no path.
    const reg = await readRegistry(bucket)
    assert('readRegistry: entry persisted', reg.grimoires.length === 1)
    assert('readRegistry: persisted entry has no path', reg.grimoires[0]?.path === undefined)
    assert('readRegistry: lastActiveId points at the new grimoire', reg.lastActiveId === g.id)
  })

  // ---- 2. duplicate name rejected -------------------------------------

  await withTempBucket(async (bucket) => {
    await createGrimoire(bucket, 'Dups')
    let threw = false
    try {
      await createGrimoire(bucket, 'Dups')
    } catch (err) {
      threw = err instanceof Error && /already exists/i.test(err.message)
    }
    assert('createGrimoire: duplicate name throws "already exists"', threw)
  })

  // ---- 3. legacy entry with path still parses -------------------------

  await withTempBucket(async (bucket) => {
    const externalDir = path.join(os.tmpdir(), 'markforge-grimoire-legacy')
    await fs.mkdir(externalDir, { recursive: true })
    try {
      await createGrimoire(bucket, 'Cloud', { path: externalDir })
      const reg = await readRegistry(bucket)
      assert('readRegistry: legacy entry with path round-trips', reg.grimoires[0]?.path === externalDir)
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true })
    }
  })

  // ---- 4. mixed registry: new + legacy coexist ------------------------

  await withTempBucket(async (bucket) => {
    const externalDir = path.join(os.tmpdir(), 'markforge-grimoire-mixed')
    await fs.mkdir(externalDir, { recursive: true })
    try {
      await createGrimoire(bucket, 'First', { path: externalDir })
      await createGrimoire(bucket, 'Second')
      const reg = await readRegistry(bucket)
      assert('mixed registry: two entries', reg.grimoires.length === 2)
      assert('mixed registry: one has path', reg.grimoires.some((g) => g.path === externalDir))
      assert('mixed registry: one has no path', reg.grimoires.some((g) => g.path === undefined))
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true })
    }
  })

  // ---- report ---------------------------------------------------------

  for (const name of ok) console.log(`  ok  ${name}`)
  for (const name of fail) console.log(`  FAIL ${name}`)
  console.log(`\n${ok.length} passed, ${fail.length} failed`)
  if (fail.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
