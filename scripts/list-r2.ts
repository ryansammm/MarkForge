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

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
  forcePathStyle: true,
})

async function listAll(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: 'markdown', Prefix: prefix, ContinuationToken: token }))
    for (const i of r.Contents ?? []) if (i.Key) keys.push(i.Key)
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function main() {
  const noteKeys = await listAll('notes/')
  const folders = new Set<string>()
  const roots: string[] = []
  for (const k of noteKeys) {
    const rel = k.replace('notes/', '')
    if (!rel || rel === '.keep') continue
    const parts = rel.split('/')
    if (parts.length > 1) folders.add(parts[0])
    else roots.push(rel)
  }

  console.log('Folders:', [...folders].sort().join(', '))
  console.log('Root files:', roots.length, roots.slice(0, 10))
  console.log('Total objects:', noteKeys.length)
  for (const f of [...folders].sort()) {
    const count = noteKeys.filter(k => k.startsWith('notes/' + f + '/')).length
    console.log(`  ${f}: ${count} objects`)
  }

  const metaKeys = await listAll('_meta/')
  console.log('Meta keys:', metaKeys)
}

main()
