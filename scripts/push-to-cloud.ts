import * as path from 'path'
import * as process from 'process'
import { FsBucket } from '../lib/server/fs-bucket'
import { R2Bucket } from '../lib/server/r2-bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'

/**
 * One-way push of a local notes directory to R2 - the engine behind the
 * desktop's "Sync to cloud" action.
 *
 * Deliberately create-only: a document that already exists in the bucket is
 * skipped, never overwritten. The cloud may hold edits made through the web
 * app, and a desktop push must not silently clobber them. Existing-count comes
 * back to the caller so the UI can say what was left alone.
 *
 * Prints exactly one JSON line on stdout ({copied, skipped, documents}) so the
 * spawning process can machine-read the outcome; chatter goes to stderr.
 * Requires R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 * in the environment.
 */

async function main() {
  const args = process.argv.slice(2)
  let dir = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = path.resolve(args[++i] ?? '')
  }
  if (!dir) throw new Error('--dir <notesDir> is required')

  const source = new FsBucket({ notesDir: dir })
  const dest = new R2Bucket()

  const documents = await source.listKeys()
  const existing = new Set(await dest.listKeys())
  console.error(`push: ${documents.length} local, ${existing.size} already in bucket`)

  let copied = 0
  let skipped = 0
  for (const key of documents) {
    if (existing.has(key)) {
      skipped++
      continue
    }
    const body = await source.readText(key)
    if (body === null) {
      console.error(`  ! ${key}: disappeared from the source`)
      continue
    }
    await dest.writeText(key, body)
    copied++
    if (copied % 25 === 0) console.error(`  … ${copied}`)
  }

  // The destination index is rebuilt once, derived from storage - same rule as
  // everywhere else an index appears.
  const index = await new WorkspaceStore(dest).reindex()
  process.stdout.write(
    `${JSON.stringify({ copied, skipped, documents: Object.keys(index.documents).length })}\n`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
