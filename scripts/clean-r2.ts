import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { readFileSync } from 'fs'

const envLines = readFileSync('.env', 'utf-8').split('\n')
for (const line of envLines) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

const BUCKET = process.env.R2_BUCKET ?? 'markdown'
const c = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
  forcePathStyle: true,
})

async function listAll(prefix: string): Promise<{ Key: string; Size: number }[]> {
  const out: { Key: string; Size: number }[] = []
  let token: string | undefined
  do {
    const r = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }))
    for (const i of r.Contents ?? []) if (i.Key) out.push({ Key: i.Key, Size: i.Size ?? 0 })
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return out
}

async function deleteBatch(keys: string[]): Promise<{ ok: number; errors: string[] }> {
  const errors: string[] = []
  let ok = 0
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    const r = await c.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch.map((Key) => ({ Key })) } }))
    for (const e of r.Errors ?? []) errors.push(`${e.Key}: ${e.Message}`)
    ok += batch.length - (r.Errors?.length ?? 0)
  }
  return { ok, errors }
}

const DELETE_PREFIXES = [
  '_meta/.trash/',
  '_meta/_grimoires/',
  'notes/Work/',
  'notes/Tes/',
  'notes/Tes 2/',
  'notes/Folder Tes 2/',
  'notes/assets/',
]
const DELETE_EXACT = ['_meta/grimoires.json']

async function plan() {
  const toDelete: { Key: string; Size: number }[] = []
  for (const p of DELETE_PREFIXES) {
    const keys = await listAll(p)
    toDelete.push(...keys)
  }
  for (const k of DELETE_EXACT) {
    const exact = await listAll(k)
    toDelete.push(...exact)
  }
  return toDelete
}

async function main() {
  const args = process.argv.slice(2)
  const yes = args.includes('--yes')
  const list = args.includes('--list')

  const planKeys = await plan()
  const totalBytes = planKeys.reduce((s, k) => s + k.Size, 0)
  console.log(`Bucket: ${BUCKET}`)
  console.log(`Delete plan: ${planKeys.length} objects, ${(totalBytes / 1024).toFixed(2)} KiB`)
  if (list || !yes) {
    if (list) {
      for (const k of planKeys) console.log(`  ${k.Size}B  ${k.Key}`)
    } else {
      const byPrefix: Record<string, number> = {}
      for (const k of planKeys) {
        const m = k.Key.match(/^([^/]+\/[^/]+\/)/) ?? k.Key.match(/^([^/]+\/)/)
        const p = m ? m[1] : k.Key
        byPrefix[p] = (byPrefix[p] ?? 0) + 1
      }
      for (const [p, n] of Object.entries(byPrefix)) console.log(`  ${n}  ${p}`)
      console.log('Pass --list to print every key, --yes to delete.')
      return
    }
  }

  console.log('Deleting...')
  const { ok, errors } = await deleteBatch(planKeys.map((k) => k.Key))
  console.log(`OK: ${ok}, errors: ${errors.length}`)
  for (const e of errors) console.log('  ' + e)
}

main().catch((e) => { console.error(e); process.exit(1) })
