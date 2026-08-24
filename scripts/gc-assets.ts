import { createBucket } from '../lib/server/store'
import { ASSET_PREFIX } from '../lib/server/assets'
import { TRASH_PREFIX, parseEntryFileKey } from '../lib/trash'
import type { Bucket } from '../lib/server/bucket'

/**
 * Finds images no document mentions any more.
 *
 *   npm run gc:assets                    report, delete nothing
 *   npm run gc:assets -- --force         delete the orphans it reports
 *   npm run gc:assets -- --min-age 30    only consider images older than 30 days
 *
 * **Deleting a document does not delete its images**, by design (sprint 7, decision
 * D5). The trash stashes and restores Markdown only, so a delete that cascaded into
 * image bytes would be a delete with no undo — and worse, a silent one, because the
 * document would come back from the trash looking whole while its pictures were gone
 * for good. Orphans are therefore tolerated, and collecting them is a thing a person
 * does on purpose, having read a list.
 *
 * That is also why the default is a report and `--force` is a separate word. This
 * script is not scheduled anywhere and should not be.
 *
 * Two rules that keep it from eating live data:
 *
 *   - **The trash counts as a reference.** A document deleted yesterday still names
 *     its images, and restoring it inside the 30-day window has to bring back a
 *     document whose pictures still load.
 *   - **Nothing recent is deleted.** An image uploaded a minute ago and not yet saved
 *     into a document is indistinguishable from one abandoned last year, except by
 *     age. `--min-age` defaults to 7 days, and `--force` refuses anything younger no
 *     matter what the report says.
 */

const DEFAULT_MIN_AGE_DAYS = 7

export interface Asset {
  path: string
  size: number
  modifiedAt: string
}

interface Options {
  force: boolean
  minAgeDays: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = { force: false, minAgeDays: DEFAULT_MIN_AGE_DAYS }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--force') {
      options.force = true
    } else if (arg === '--min-age') {
      const days = Number(argv[++i])
      if (!Number.isFinite(days) || days < 0) throw new Error('--min-age needs a number of days')
      options.minAgeDays = days
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

/**
 * Everything that could be holding a reference to an image.
 *
 * The live corpus plus every document sitting in the trash. Read as raw text rather
 * than parsed: a reference is a reference whether it is `![alt](path)`, an HTML `img`
 * tag someone pasted, or a bare mention in a code fence — and the cost of being wrong
 * in that direction is a stale file, while the cost of being wrong in the other is a
 * picture that vanishes from someone's note.
 */
async function referenceText(bucket: Bucket): Promise<string[]> {
  const texts: string[] = []

  for (const key of await bucket.listKeys()) {
    const body = await bucket.readText(key)
    if (body !== null) texts.push(body)
  }

  for (const name of await bucket.listMeta(TRASH_PREFIX)) {
    // Entry manifests are metadata about the deletion, not document content, and
    // parseEntryFileKey is what tells the two apart.
    if (!parseEntryFileKey(name)) continue
    const body = await bucket.readMeta(name)
    if (body !== null) texts.push(body)
  }

  return texts
}

/** Assets that nothing — live or trashed — mentions. */
export async function findOrphans(bucket: Bucket): Promise<Asset[]> {
  const keys = await bucket.listBinaryKeys(ASSET_PREFIX)
  if (keys.length === 0) return []

  const texts = await referenceText(bucket)
  const orphans: Asset[] = []

  for (const path of keys) {
    if (texts.some((text) => text.includes(path))) continue

    const stat = await bucket.statObject(path)
    orphans.push({
      path,
      size: stat?.size ?? 0,
      // A backend that cannot say loses the benefit of the doubt: an unknown age is
      // treated as "just now", so --force leaves it alone rather than guessing.
      modifiedAt: stat?.modifiedAt ?? new Date().toISOString(),
    })
  }

  return orphans
}

export function ageInDays(asset: Asset, now: number = Date.now()): number {
  return (now - new Date(asset.modifiedAt).getTime()) / 86_400_000
}

/**
 * Deletes the orphans old enough to be deleted, and says which it left behind.
 *
 * Never called without `--force`.
 */
export async function removeOrphans(
  bucket: Bucket,
  orphans: Asset[],
  options: { minAgeDays: number; now?: number }
): Promise<{ deleted: Asset[]; tooRecent: Asset[] }> {
  const now = options.now ?? Date.now()
  const deleted: Asset[] = []
  const tooRecent: Asset[] = []

  for (const asset of orphans) {
    if (ageInDays(asset, now) < options.minAgeDays) {
      tooRecent.push(asset)
      continue
    }
    await bucket.deleteObject(asset.path)
    deleted.push(asset)
  }

  return { deleted, tooRecent }
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const bucket = createBucket()

  const total = (await bucket.listBinaryKeys(ASSET_PREFIX)).length
  const orphans = await findOrphans(bucket)

  console.log(`Assets in ${bucket.kind}: ${total}`)
  console.log(`  referenced by a document (including the trash): ${total - orphans.length}`)
  console.log(`  referenced by nothing: ${orphans.length}\n`)

  if (orphans.length === 0) {
    console.log('Nothing to collect.')
    return
  }

  const bytes = orphans.reduce((sum, asset) => sum + asset.size, 0)
  for (const asset of orphans.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`  ${asset.path}  ${kb(asset.size)}  ${ageInDays(asset).toFixed(0)}d old`)
  }
  console.log(`\n  ${orphans.length} orphaned image(s), ${kb(bytes)}`)

  if (!options.force) {
    console.log(
      '\nNothing was deleted. Deleting a document deliberately does not delete its' +
        '\nimages, so an orphan here may be one you are about to reuse — and an image' +
        '\nuploaded moments ago has no reference yet either.' +
        `\n\nTo remove the ones older than ${options.minAgeDays} days:` +
        '\n  npm run gc:assets -- --force'
    )
    return
  }

  const { deleted, tooRecent } = await removeOrphans(bucket, orphans, {
    minAgeDays: options.minAgeDays,
  })

  for (const asset of tooRecent) {
    console.log(`  kept (newer than ${options.minAgeDays}d)  ${asset.path}`)
  }
  console.log(`\nDeleted ${deleted.length} of ${orphans.length}, freeing ${kb(
    deleted.reduce((sum, a) => sum + a.size, 0)
  )}.`)
  if (tooRecent.length > 0) {
    console.log(`Kept ${tooRecent.length} that were too recent to be sure about.`)
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${(err as Error).message}`)
    process.exit(1)
  })
}
