import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { readFileSync } from 'fs'

const envLines = readFileSync('.env', 'utf-8').split('\n')
for (const line of envLines) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

const c = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
  forcePathStyle: true,
})

async function list(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const r = await c.send(new ListObjectsV2Command({ Bucket: 'markdown', Prefix: prefix, ContinuationToken: token }))
    for (const i of r.Contents ?? []) if (i.Key) keys.push(i.Key)
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function main() {
  const trash = await list('_meta/.trash/')
  const trashGroups = new Set<string>()
  for (const k of trash) {
    const m = k.match(/^_meta\/.trash\/([^/]+)\//)
    if (m) trashGroups.add(m[1])
  }
  console.log('trash groups:', trashGroups.size, 'trash objects:', trash.length)

  const assets = await list('notes/assets/')
  console.log('assets:', assets)

  const all = await list('')
  const topLevel = new Set<string>()
  for (const k of all) {
    const m = k.match(/^([^/]+)\//)
    if (m) topLevel.add(m[1])
  }
  console.log('top-level prefixes:', [...topLevel].sort())

  const metaAll = await list('_meta/')
  const metaTop = new Set<string>()
  for (const k of metaAll) {
    const rel = k.replace(/^_meta\//, '')
    if (!rel) continue
    const first = rel.split('/')[0]
    metaTop.add(first)
  }
  console.log('meta top-level:', [...metaTop].sort())

  const notes = await list('notes/')
  const notesFolders = new Set<string>()
  for (const k of notes) {
    const rel = k.replace(/^notes\//, '')
    if (!rel) continue
    const first = rel.split('/')[0]
    if (first.includes('/')) continue
    if (first.endsWith('.md')) continue
    notesFolders.add(first)
  }
  console.log('notes folders:', [...notesFolders].sort())
}

main().catch((e) => { console.error(e); process.exit(1) })
