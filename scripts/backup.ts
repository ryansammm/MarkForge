import * as fs from 'fs/promises'
import * as path from 'path'
import { createBucket } from '../lib/server/store'
import { WorkspaceStore, computeBinaryEtag, computeEtag } from '../lib/server/workspace-store'
import { TRASH_PREFIX } from '../lib/trash'
import { VAULT_FILE } from '../lib/vault/record'
import type { Bucket } from '../lib/server/bucket'
import { ASSET_PREFIX, contentTypeForKey } from '../lib/server/assets'

/**
 * Backup, restore, and the drill that proves the backup is real.
 *
 *   npm run backup                        snapshot the configured backend
 *   npm run backup -- --verify <dir>      diff a snapshot against live storage
 *   npm run backup -- --restore <dir>     write a snapshot into the configured backend
 *
 * A backup that has never been restored is a belief, not a backup — which is why
 * `--restore` and `--verify` ship with the thing that writes them rather than being
 * left as an exercise for the worst day of the year.
 *
 * What a snapshot holds, and why:
 *
 *   documents/    the corpus. The actual product.
 *   assets/       the images the documents embed. Not derivable from anything: a
 *                 snapshot without them restores a corpus of broken pictures, and
 *                 unlike a missing index there is nothing to rebuild them from.
 *   meta/         shares.json — **live credentials**. Restoring a corpus without it
 *                 silently revokes every link anyone was ever sent, which is a
 *                 different disaster from the one being recovered.
 *                 password-vault.json — the encrypted vault, which exists in exactly
 *                 one place and is not derivable from anything. It is copied as
 *                 ciphertext and never parsed for content; `--verify` checks its
 *                 bytes are intact, which is all anything outside a browser can check.
 *   trash/        deleted-but-recoverable documents. A backup that drops these
 *                 quietly narrows the recovery window it exists to widen.
 *   manifest.json paths, etags, and byte counts — what `--verify` compares against.
 *
 * index.json is deliberately **not** backed up. It is derived data, and a restore
 * rebuilds it from the documents, which also makes every restore a reindex drill.
 */

interface Manifest {
  createdAt: string
  backend: string
  documents: Array<{ path: string; etag: string; bytes: number }>
  folders: string[]
  meta: string[]
  /**
   * Images, hashed over their bytes rather than as text.
   *
   * Optional for the same reason `metaEtags` is: a snapshot taken before assets
   * existed is still a valid snapshot, and must verify rather than report every image
   * in live storage as an unexplained new file.
   */
  assets?: Array<{ path: string; etag: string; bytes: number }>
  /**
   * Content hashes for the metadata objects, keyed by name.
   *
   * Optional so a snapshot taken before this existed still verifies — it simply
   * cannot check what it never recorded. New snapshots always carry it, which is what
   * makes "the vault ciphertext in this backup is byte-for-byte what was stored"
   * something a script can assert rather than something a human assumes.
   */
  metaEtags?: Record<string, string>
}

type Mode = 'backup' | 'verify' | 'restore'

interface Options {
  mode: Mode
  dir: string
  force: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: 'backup', dir: '', force: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--verify') {
      options.mode = 'verify'
      options.dir = path.resolve(argv[++i] ?? '')
    } else if (arg === '--restore') {
      options.mode = 'restore'
      options.dir = path.resolve(argv[++i] ?? '')
    } else if (arg === '--out') {
      options.dir = path.resolve(argv[++i] ?? '')
    } else if (arg === '--force') {
      options.force = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.mode !== 'backup' && !options.dir) {
    throw new Error(`${options.mode === 'verify' ? '--verify' : '--restore'} needs a snapshot directory`)
  }
  if (!options.dir) {
    // Colons are illegal in Windows paths, so the timestamp is flattened.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    options.dir = path.resolve(process.cwd(), 'backups', stamp)
  }
  return options
}

async function writeFile(target: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, body, 'utf-8')
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function writeBytes(target: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, bytes)
}

async function readBytesOrNull(target: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Where an image sits inside a snapshot.
 *
 * Its vault key already begins with `assets/`, so it is laid down at the snapshot
 * root as a sibling of `documents/` and `meta/` — the directory mirrors the vault,
 * and nothing has to be re-derived on the way back in.
 */
function assetFile(dir: string, key: string): string {
  return path.join(dir, key)
}

/**
 * Metadata worth keeping: share tokens, the encrypted vault, and the trash.
 *
 * Never the index — it is derived. The vault is the opposite of derived: it is the
 * only copy of data that cannot be reconstructed from anything else in the backup,
 * and a restore that dropped it would present the owner with a working workspace and
 * an empty password manager.
 */
async function metaKeys(bucket: Bucket): Promise<string[]> {
  const keys = [...(await bucket.listMeta(TRASH_PREFIX))]
  if ((await bucket.readMeta('shares.json')) !== null) keys.push('shares.json')
  if ((await bucket.readMeta(VAULT_FILE)) !== null) keys.push(VAULT_FILE)
  return keys.sort()
}

async function backup(bucket: Bucket, dir: string): Promise<void> {
  const documents = await bucket.listKeys()
  const folders = await bucket.listFolders()
  const assets = await bucket.listBinaryKeys(ASSET_PREFIX)
  const meta = await metaKeys(bucket)

  console.log(`Backing up ${bucket.kind} -> ${dir}`)
  console.log(
    `  ${documents.length} documents, ${assets.length} images, ${folders.length} folders, ${meta.length} metadata objects\n`
  )

  if (documents.length === 0 && assets.length === 0 && meta.length === 0) {
    throw new Error('Storage is empty. Refusing to write an empty snapshot over a real backup directory.')
  }

  const manifest: Manifest = {
    createdAt: new Date().toISOString(),
    backend: bucket.kind,
    documents: [],
    folders,
    meta,
    metaEtags: {},
    assets: [],
  }

  for (const key of documents) {
    const body = await bucket.readText(key)
    if (body === null) {
      console.error(`  ! ${key}: disappeared mid-backup`)
      continue
    }
    await writeFile(path.join(dir, 'documents', key), body)
    manifest.documents.push({ path: key, etag: computeEtag(body), bytes: Buffer.byteLength(body, 'utf8') })
  }

  for (const key of assets) {
    const asset = await bucket.readBinary(key)
    if (asset === null) {
      console.error(`  ! ${key}: disappeared mid-backup`)
      continue
    }
    await writeBytes(assetFile(dir, key), asset.bytes)
    manifest.assets!.push({
      path: key,
      etag: computeBinaryEtag(asset.bytes),
      bytes: asset.bytes.byteLength,
    })
  }

  for (const key of meta) {
    const body = await bucket.readMeta(key)
    if (body === null) continue
    await writeFile(path.join(dir, 'meta', key), body)
    // Hashed, not inspected. For the vault this is the only integrity check anything
    // outside a browser is capable of — the contents are unreadable here by design.
    manifest.metaEtags![key] = computeEtag(body)
  }

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const bytes = manifest.documents.reduce((sum, doc) => sum + doc.bytes, 0)
  const assetBytes = manifest.assets!.reduce((sum, asset) => sum + asset.bytes, 0)
  console.log(`  wrote ${manifest.documents.length} documents (${(bytes / 1024).toFixed(1)} KB)`)
  if (manifest.assets!.length > 0) {
    console.log(`  wrote ${manifest.assets!.length} images (${(assetBytes / 1024).toFixed(1)} KB)`)
  }
  console.log(`\nDone. Verify it with:\n  npm run backup -- --verify ${dir}`)
}

/**
 * Compares a snapshot against live storage and names every difference.
 *
 * Exits non-zero on any drift, so it works as a scheduled check rather than only as
 * something a person reads.
 */
async function verify(bucket: Bucket, dir: string): Promise<boolean> {
  const raw = await readFileOrNull(path.join(dir, 'manifest.json'))
  if (!raw) throw new Error(`No manifest.json in ${dir} — that is not a snapshot directory.`)
  const manifest = JSON.parse(raw) as Manifest

  console.log(`Verifying ${dir}`)
  console.log(`  taken ${manifest.createdAt} from ${manifest.backend}, against live ${bucket.kind}\n`)

  const problems: string[] = []
  const live = new Set(await bucket.listKeys())

  for (const entry of manifest.documents) {
    const snapshot = await readFileOrNull(path.join(dir, 'documents', entry.path))
    if (snapshot === null) {
      problems.push(`missing from the snapshot: ${entry.path}`)
      continue
    }
    if (computeEtag(snapshot) !== entry.etag) {
      problems.push(`snapshot file does not match its manifest etag: ${entry.path}`)
    }

    const current = await bucket.readText(entry.path)
    if (current === null) problems.push(`deleted since the backup: ${entry.path}`)
    else if (computeEtag(current) !== entry.etag) problems.push(`changed since the backup: ${entry.path}`)

    live.delete(entry.path)
  }

  for (const key of live) problems.push(`created since the backup: ${key}`)

  // Skipped entirely for a snapshot taken before images existed: it cannot be faulted
  // for not recording them, and reporting every live image as "new" would bury the
  // differences that do matter.
  if (manifest.assets) {
    const liveAssets = new Set(await bucket.listBinaryKeys(ASSET_PREFIX))

    for (const entry of manifest.assets) {
      const snapshot = await readBytesOrNull(assetFile(dir, entry.path))
      if (snapshot === null) {
        problems.push(`missing from the snapshot: ${entry.path}`)
        continue
      }
      if (computeBinaryEtag(snapshot) !== entry.etag) {
        problems.push(`snapshot image does not match its manifest etag: ${entry.path}`)
      }

      const current = await bucket.readBinary(entry.path)
      if (current === null) problems.push(`deleted since the backup: ${entry.path}`)
      else if (computeBinaryEtag(current.bytes) !== entry.etag) {
        // Worth naming even though it should be impossible: an asset key contains a
        // hash of its own bytes, so content changing under a stable key means
        // something outside this app rewrote it.
        problems.push(`changed since the backup: ${entry.path}`)
      }

      liveAssets.delete(entry.path)
    }

    for (const key of liveAssets) problems.push(`created since the backup: ${key}`)
  }

  for (const key of manifest.meta) {
    const snapshot = await readFileOrNull(path.join(dir, 'meta', key))
    if (snapshot === null) {
      problems.push(`missing from the snapshot: meta/${key}`)
      continue
    }

    const expected = manifest.metaEtags?.[key]
    if (expected === undefined) continue // A snapshot from before hashes were recorded.

    if (computeEtag(snapshot) !== expected) {
      problems.push(`snapshot copy does not match its manifest etag: meta/${key}`)
    }

    const current = await bucket.readMeta(key)
    if (current === null) problems.push(`deleted since the backup: meta/${key}`)
    else if (computeEtag(current) !== expected) problems.push(`changed since the backup: meta/${key}`)
  }

  if (problems.length === 0) {
    const images = manifest.assets?.length ? ` and ${manifest.assets.length} images` : ''
    console.log(`  ${manifest.documents.length} documents${images} match live storage exactly.`)
    console.log('\nOK.')
    return true
  }

  // Drift is expected on a live corpus — the point is that it is named, not that it
  // is zero. A restore is only trustworthy when you know what it will not contain.
  console.log(`  ${problems.length} difference(s):\n`)
  for (const problem of problems.slice(0, 50)) console.log(`    ${problem}`)
  if (problems.length > 50) console.log(`    … and ${problems.length - 50} more`)
  console.log('')
  return false
}

async function restore(bucket: Bucket, dir: string, force: boolean): Promise<void> {
  const raw = await readFileOrNull(path.join(dir, 'manifest.json'))
  if (!raw) throw new Error(`No manifest.json in ${dir} — that is not a snapshot directory.`)
  const manifest = JSON.parse(raw) as Manifest

  const existing = await bucket.listKeys()
  if (existing.length > 0 && !force) {
    throw new Error(
      `Refusing to restore: ${bucket.kind} already holds ${existing.length} documents.\n` +
        'A restore does not delete, so the result would be a mixture of two corpora.\n' +
        'Restore into an empty bucket — that is the drill — or re-run with --force.'
    )
  }

  console.log(`Restoring ${dir} -> ${bucket.kind}`)
  console.log(`  snapshot taken ${manifest.createdAt}\n`)

  for (const folder of manifest.folders) await bucket.createFolder(folder)

  let restored = 0
  for (const entry of manifest.documents) {
    const body = await readFileOrNull(path.join(dir, 'documents', entry.path))
    if (body === null) {
      console.error(`  ! ${entry.path}: missing from the snapshot`)
      continue
    }
    if (computeEtag(body) !== entry.etag) {
      // Refusing beats restoring a file the manifest says is not what was backed up.
      throw new Error(`${entry.path} does not match its manifest etag — the snapshot is damaged.`)
    }
    await bucket.writeText(entry.path, body)
    restored++
  }

  let restoredAssets = 0
  for (const entry of manifest.assets ?? []) {
    const bytes = await readBytesOrNull(assetFile(dir, entry.path))
    if (bytes === null) {
      console.error(`  ! ${entry.path}: missing from the snapshot`)
      continue
    }
    if (computeBinaryEtag(bytes) !== entry.etag) {
      throw new Error(`${entry.path} does not match its manifest etag — the snapshot is damaged.`)
    }
    // The type is derived from the key, exactly as a fresh upload's would be, so a
    // restored image is served identically to one that never left.
    await bucket.writeBinary(entry.path, bytes, contentTypeForKey(entry.path))
    restoredAssets++
  }

  for (const key of manifest.meta) {
    const body = await readFileOrNull(path.join(dir, 'meta', key))
    if (body === null) continue

    const expected = manifest.metaEtags?.[key]
    if (expected !== undefined && computeEtag(body) !== expected) {
      // Same rule as a document: refusing beats restoring bytes the manifest says are
      // not the bytes that were backed up. A vault with one flipped bit does not
      // decrypt, and would look exactly like a forgotten master password.
      throw new Error(`meta/${key} does not match its manifest etag — the snapshot is damaged.`)
    }

    await bucket.writeMeta(key, body)
  }

  console.log(`  restored ${restored}/${manifest.documents.length} documents`)
  if (manifest.assets?.length) {
    console.log(`  restored ${restoredAssets}/${manifest.assets.length} images`)
  }

  // Rebuilt rather than restored: the index is derived, and rebuilding it here makes
  // every restore a reindex drill as well.
  console.log('  rebuilding the index…')
  const index = await new WorkspaceStore(bucket).reindex()
  console.log(`  index: ${Object.keys(index.documents).length} documents`)

  if (restored !== manifest.documents.length || restoredAssets !== (manifest.assets?.length ?? 0)) {
    throw new Error('The restore is incomplete — see the errors above.')
  }
  console.log(`\nDone. Confirm it with:\n  npm run backup -- --verify ${dir}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const bucket = createBucket()

  if (options.mode === 'backup') return backup(bucket, options.dir)
  if (options.mode === 'restore') return restore(bucket, options.dir, options.force)

  if (!(await verify(bucket, options.dir))) process.exit(1)
}

/**
 * Guarded so the suite can drive these directly.
 *
 * Without it, importing this module to test a restore would take a backup of whatever
 * the ambient environment points at — which on a developer's machine is their vault.
 */
if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${(err as Error).message}`)
    process.exit(1)
  })
}

export { backup, verify, restore }
