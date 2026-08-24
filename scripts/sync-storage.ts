import * as path from 'path'
import type { Bucket } from '../lib/server/bucket'
import { FsBucket } from '../lib/server/fs-bucket'
import { R2Bucket } from '../lib/server/r2-bucket'
import { WorkspaceStore } from '../lib/server/workspace-store'
import { ASSET_PREFIX } from '../lib/server/assets'

/**
 * Copies a corpus between storage backends.
 *
 * Exists because the R2 backend arriving does not put anything in the bucket — a
 * correctly configured deployment with an empty bucket shows an empty workspace,
 * which looks exactly like a broken one.
 *
 * Falls out of the Bucket abstraction almost for free, and works in both directions:
 * seeding production from a local vault, and pulling production back down for a
 * backup or to inspect it.
 *
 * The destination index is **rebuilt**, never copied. An index copied between
 * backends would be trusted rather than derived, and the whole premise is that it is
 * derived. Rebuilding also means this doubles as a reindex drill against real
 * storage.
 *
 *   npm run sync -- --from fs --to r2 --dry-run
 *   npm run sync -- --from fs --to r2
 *   npm run sync -- --from r2 --to fs --dest ./backup
 */

type BackendName = 'fs' | 'r2'

interface Options {
  from: BackendName
  to: BackendName
  dryRun: boolean
  force: boolean
  /** Local directory for the fs side. */
  dir: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    from: 'fs',
    to: 'r2',
    dryRun: false,
    force: false,
    dir: path.resolve(process.cwd(), 'notes'),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--from') options.from = expectBackend(argv[++i], '--from')
    else if (arg === '--to') options.to = expectBackend(argv[++i], '--to')
    else if (arg === '--dir' || arg === '--dest') options.dir = path.resolve(argv[++i] ?? '')
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.from === options.to) {
    throw new Error('--from and --to must be different backends')
  }
  return options
}

function expectBackend(value: string | undefined, flag: string): BackendName {
  if (value !== 'fs' && value !== 'r2') {
    throw new Error(`${flag} must be "fs" or "r2" (got ${JSON.stringify(value)})`)
  }
  return value
}

function makeBucket(name: BackendName, dir: string): Bucket {
  if (name === 'r2') return new R2Bucket()
  // Only notesDir is overridden, so index.json lands wherever the app itself puts
  // it — INDEX_PATH, or public/index.json. A sync that wrote the index somewhere
  // else would leave the local app reading a stale one.
  return new FsBucket({ notesDir: dir })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  const source = makeBucket(options.from, options.dir)
  const destination = makeBucket(options.to, options.dir)

  console.log(`Sync: ${options.from} -> ${options.to}`)
  if (options.from === 'fs' || options.to === 'fs') console.log(`  local directory: ${options.dir}`)
  if (options.dryRun) console.log('  DRY RUN — nothing will be written\n')
  else console.log('')

  const documents = await source.listKeys()
  const folders = await source.listFolders()
  // Copied for the same reason the documents are: a migration that moves the notes
  // and leaves the images behind produces a vault full of links to nothing, on a
  // backend the old one is about to be turned off in favour of.
  const assets = await source.listBinaryKeys(ASSET_PREFIX)

  console.log(
    `  source: ${documents.length} documents, ${assets.length} images, ${folders.length} folders`
  )

  const existing = await destination.listKeys()
  console.log(`  destination: ${existing.length} documents`)

  if (existing.length > 0 && !options.force && !options.dryRun) {
    console.error(
      `\nRefusing to write: the destination already holds ${existing.length} documents.` +
        '\nThis copy does not delete, so anything not in the source would be left behind' +
        '\nand the result would be a mixture of two corpora.' +
        '\nRe-run with --force if that is what you want.'
    )
    process.exit(1)
  }

  if (documents.length === 0) {
    console.error('\nSource is empty — nothing to copy. Check --dir or the R2 settings.')
    process.exit(1)
  }

  if (options.dryRun) {
    const all = [...documents, ...assets]
    for (const key of all.slice(0, 20)) console.log(`    would copy  ${key}`)
    if (all.length > 20) console.log(`    … and ${all.length - 20} more`)
    console.log('\nDry run complete. Re-run without --dry-run to apply.')
    return
  }

  console.log('')
  let copied = 0
  let failed = 0

  // Folders first, so an empty one survives even if it holds nothing to copy.
  for (const folder of folders) {
    try {
      await destination.createFolder(folder)
    } catch (err) {
      console.error(`  ! folder ${folder}: ${(err as Error).message}`)
      failed++
    }
  }

  for (const key of documents) {
    try {
      const body = await source.readText(key)
      if (body === null) {
        console.error(`  ! ${key}: disappeared from the source`)
        failed++
        continue
      }
      await destination.writeText(key, body)
      copied++
      if (copied % 25 === 0) console.log(`  … ${copied}/${documents.length}`)
    } catch (err) {
      console.error(`  ! ${key}: ${(err as Error).message}`)
      failed++
    }
  }

  let copiedAssets = 0
  for (const key of assets) {
    try {
      const asset = await source.readBinary(key)
      if (asset === null) {
        console.error(`  ! ${key}: disappeared from the source`)
        failed++
        continue
      }
      await destination.writeBinary(key, asset.bytes, asset.contentType)
      copiedAssets++
    } catch (err) {
      console.error(`  ! ${key}: ${(err as Error).message}`)
      failed++
    }
  }

  console.log(`\n  copied ${copied}/${documents.length} documents`)
  if (assets.length > 0) console.log(`  copied ${copiedAssets}/${assets.length} images`)

  // Rebuilt, not copied. The index is derived data, and rebuilding it here is also
  // a reindex drill against whatever backend just received the corpus.
  console.log('  rebuilding the destination index…')
  const index = await new WorkspaceStore(destination).reindex()
  console.log(`  index: ${Object.keys(index.documents).length} documents`)

  if (failed > 0) {
    console.error(`\nFinished with ${failed} failure(s). The copy is incomplete.`)
    process.exit(1)
  }
  console.log('\nDone.')
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}`)
  process.exit(1)
})
