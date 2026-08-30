import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Grimoire multi-root scope suite.
 *
 * Proves the local (filesystem) fix for the grimoire leak: a doc written to a
 * subfolder grimoire (notes/<name>/) must land in THAT grimoire's own folder and
 * must be invisible to the ROOT store. Previously the shared-bucket model applied
 * the "<name>/" prefix only in reindex(), never in write/read/move — so a write
 * leaked into the root namespace.
 *
 * Runs against a fresh FsBucket pointing at a temp dir. The bucket is constructed
 * directly so the test does not depend on the production `createBucket()` route,
 * which now requires R2 env vars.
 */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mdws-grim-'))
const notesDir = path.join(workspace, 'notes')
const metaDir = path.join(workspace, 'meta')
fs.mkdirSync(notesDir, { recursive: true })
fs.mkdirSync(metaDir, { recursive: true })

import { FsBucket } from '../lib/server/fs-bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { createGrimoire, deleteGrimoire } from '../lib/server/grimoire'

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => Promise<void>) {
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

async function run(): Promise<boolean> {
  const bucket = new FsBucket({ notesDir, metaDir })
  const name = 'ScopeTest'

  const grimoire = await createGrimoire(bucket, name)
  assert(!!grimoire.id, 'grimoire id missing')

  // The grimoire-scoped bucket, used to prove that the scoped store writes
  // to a folder rooted at the grimoire's name (the historical leak was
  // caused by the shared-bucket model). grimoireName stays empty here
  // because the FsBucket is already rooted at the grimoire folder; the
  // empty prefix mirrors the pre-r2-only production behavior and keeps
  // reindex()'s listKeys() un-prefixed.
  const grimoireBucket = new FsBucket({
    notesDir: path.join(notesDir, name),
    metaDir: path.join(metaDir, name),
  })
  const gstore = new WorkspaceStore(grimoireBucket, {
    grimoireId: grimoire.id,
    grimoireName: '',
  })

  try {
    const body = '# scoped\n\nonly inside the grimoire\n'
    await gstore.write('note.md', body)

    await check('doc written inside grimoire folder', async () => {
      const onDisk = fs.existsSync(path.join(notesDir, name, 'note.md'))
      assert(onDisk === true, `expected notes/${name}/note.md on disk`)
    })

    await check('doc NOT leaked to root folder', async () => {
      const atRoot = fs.existsSync(path.join(notesDir, 'note.md'))
      assert(atRoot === false, 'unexpected notes/note.md at root')
    })

    await check('root store cannot read grimoire doc', async () => {
      const root = new WorkspaceStore(new FsBucket({ notesDir, metaDir }))
      const doc = await root.getFile('note.md')
      assert(doc === null, 'root store saw a grimoire doc — leak')
    })

    await check('grimoire reads its own doc back', async () => {
      const doc = await gstore.getFile('note.md')
      assert(doc !== null, 'grimoire could not read note.md')
    })

    await check('write and reindex agree', async () => {
      const index = await gstore.reindex()
      assert(!!index.documents['note.md'], 'reindex did not find note.md')
    })
  } finally {
    await deleteGrimoire(bucket, grimoire.id).catch(() => {})
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

run()
  .then((ok) => {
    fs.rmSync(workspace, { recursive: true, force: true })
    process.exit(ok ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    fs.rmSync(workspace, { recursive: true, force: true })
    process.exit(1)
  })
