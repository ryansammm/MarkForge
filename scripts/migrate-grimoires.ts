/**
 * Migration script: Create Work and Origin grimoires, reorganize existing files.
 *
 * - GDI/ and K2/ folders → Work/
 * - Everything else → Origin/
 *
 * Run: node scripts/migrate-grimoires.ts
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'

// Load env from .env file
import { readFileSync } from 'fs'
const envLines = readFileSync('.env', 'utf-8').split('\n')
for (const line of envLines) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  process.env[key] = val
}

const BUCKET = 'markdown'
const NOTES_PREFIX = 'notes'
const META_PREFIX = '_meta'

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
})

async function listAll(prefix) {
  const keys = []
  let token
  do {
    const result = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
    )
    for (const item of result.Contents ?? []) {
      if (item.Key) keys.push(item.Key)
    }
    token = result.IsTruncated ? result.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function readText(key) {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    return await result.Body?.transformToString()
  } catch { return null }
}

async function writeText(key, body) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body,
    ContentLength: Buffer.byteLength(body, 'utf8'),
    ContentType: 'text/markdown; charset=utf-8',
  }))
}

async function deleteObject(key) {
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

async function main() {
  console.log('=== Grimoire Migration ===\n')

  // 1. List all files under notes/
  const allKeys = await listAll(`${NOTES_PREFIX}/`)
  console.log(`Found ${allKeys.length} total objects under notes/`)

  // Classify: folders vs root files
  const folders = new Set()
  const rootFiles = []
  for (const fullKey of allKeys) {
    const rel = fullKey.replace(`${NOTES_PREFIX}/`, '')
    if (!rel || rel === '.keep') continue
    const parts = rel.split('/')
    if (parts.length > 1 || rel.endsWith('/.keep')) {
      folders.add(parts[0])
    } else {
      rootFiles.push(rel)
    }
  }

  console.log(`Folders: ${[...folders].sort().join(', ') || '(none)'}`)
  console.log(`Root .md files: ${rootFiles.length}`)
  console.log()

  // 2. Show planned moves
  const workFolders = ['GDI', 'K2']
  const originFolders = [...folders].filter((f) => !workFolders.includes(f))

  console.log('Plan:')
  console.log(`  Work:   ${workFolders.filter((f) => folders.has(f)).join(', ') || '(empty)'}`)
  console.log(`  Origin: ${originFolders.join(', ') || '(empty)'}${rootFiles.length ? ` + ${rootFiles.length} root files` : ''}`)
  console.log()

  // 3. Create Work and Origin grimoire directories
  const putFolder = (name) => client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: `${NOTES_PREFIX}/${name}/.keep`, Body: '', ContentLength: 0,
  }))

  await putFolder('Work')
  await putFolder('Origin')

  // 4. Create grimoire registry
  const registry = {
    grimoires: [
      { id: randomUUID().slice(0, 12), name: 'Work', createdAt: new Date().toISOString(), lastActive: new Date().toISOString() },
      { id: randomUUID().slice(0, 12), name: 'Origin', createdAt: new Date().toISOString(), lastActive: new Date().toISOString() },
    ],
    lastActiveId: null,
  }
  registry.lastActiveId = registry.grimoires[0].id

  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: `${META_PREFIX}/grimoires.json`,
    Body: JSON.stringify(registry, null, 2),
    ContentLength: Buffer.byteLength(JSON.stringify(registry, null, 2), 'utf8'),
    ContentType: 'application/json',
  }))

  console.log('Registry created:')
  for (const g of registry.grimoires) {
    console.log(`  ${g.name} (id: ${g.id})`)
  }
  console.log()

  // 5. Move files
  let moved = 0

  // Move GDI/ and K2/ into Work/
  for (const folder of workFolders) {
    if (!folders.has(folder)) { console.log(`Skip ${folder}/ (not found)`); continue }
    const folderKeys = allKeys.filter((k) => {
      const rel = k.replace(`${NOTES_PREFIX}/`, '')
      return rel === `${folder}/.keep` || rel.startsWith(`${folder}/`)
    })
    console.log(`Moving ${folderKeys.length} objects: ${folder}/ → Work/${folder}/`)
    for (const srcKey of folderKeys) {
      const rel = srcKey.replace(`${NOTES_PREFIX}/`, '')
      if (rel.endsWith('/.keep')) {
        await putFolder(`Work/${folder}`)
        continue
      }
      const content = await readText(srcKey)
      if (content === null) continue
      const destKey = `${NOTES_PREFIX}/Work/${rel}`
      await writeText(destKey, content)
      await deleteObject(srcKey)
      moved++
    }
  }

  // Move remaining folders into Origin/
  for (const folder of originFolders) {
    const folderKeys = allKeys.filter((k) => {
      const rel = k.replace(`${NOTES_PREFIX}/`, '')
      return rel === `${folder}/.keep` || rel.startsWith(`${folder}/`)
    })
    console.log(`Moving ${folderKeys.length} objects: ${folder}/ → Origin/${folder}/`)
    for (const srcKey of folderKeys) {
      const rel = srcKey.replace(`${NOTES_PREFIX}/`, '')
      if (rel.endsWith('/.keep')) {
        await putFolder(`Origin/${folder}`)
        continue
      }
      const content = await readText(srcKey)
      if (content === null) continue
      const destKey = `${NOTES_PREFIX}/Origin/${rel}`
      await writeText(destKey, content)
      await deleteObject(srcKey)
      moved++
    }
  }

  // Move root .md files into Origin/
  if (rootFiles.length > 0) {
    console.log(`Moving ${rootFiles.length} root files → Origin/`)
    for (const file of rootFiles) {
      const content = await readText(`${NOTES_PREFIX}/${file}`)
      if (content === null) continue
      await writeText(`${NOTES_PREFIX}/Origin/${file}`, content)
      await deleteObject(`${NOTES_PREFIX}/${file}`)
      moved++
    }
  }

  // Delete leftover .keep markers in old locations
  for (const folder of folders) {
    await deleteObject(`${NOTES_PREFIX}/${folder}/.keep`).catch(() => {})
  }

  console.log(`\nMoved ${moved} files total`)

  // 6. Verify
  console.log('\n=== Verification ===')
  const finalKeys = await listAll(`${NOTES_PREFIX}/`)
  const workCount = finalKeys.filter((k) => k.includes('/Work/')).length
  const originCount = finalKeys.filter((k) => k.includes('/Origin/')).length
  console.log(`Work:   ${workCount} objects`)
  console.log(`Origin: ${originCount} objects`)
  console.log(`Total:  ${finalKeys.length} objects`)

  const regRaw = await readText(`${META_PREFIX}/grimoires.json`)
  const reg = JSON.parse(regRaw)
  console.log(`Registry: ${reg.grimoires.map((g) => g.name).join(', ')}`)
  console.log('\nDone!')
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1) })
