import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
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

async function getText(key: string): Promise<string> {
  const r = await c.send(new GetObjectCommand({ Bucket: 'markdown', Key: key }))
  const chunks: Buffer[] = []
  for await (const chunk of r.Body as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

async function main() {
  const indexJson = await getText('_meta/index.json')
  const searchJson = await getText('_meta/search.json')
  const idx = JSON.parse(indexJson)
  console.log('index keys:', Object.keys(idx))
  console.log('documents type:', Array.isArray(idx.documents) ? 'array' : typeof idx.documents)
  if (typeof idx.documents === 'object' && idx.documents !== null) {
    const keys = Object.keys(idx.documents)
    console.log('documents object keys count:', keys.length)
    console.log('first 5 doc keys:', keys.slice(0, 5))
    console.log('doc-key values sample:', keys.slice(0, 3).map((k) => ({ k, v: idx.documents[k] })))
    console.log('docs containing Origin/:', keys.filter((k) => k.includes('Origin/')).length)
    console.log('docs in Work/Tes/etc:', keys.filter((k) => /^(Work|Tes|Tes 2|Folder Tes 2|assets)\//.test(k)).slice(0, 20))
  }
  console.log('tree roots:', Object.keys(idx.tree ?? {}))
  console.log('---')
  console.log('search length:', searchJson.length)
  const s = JSON.parse(searchJson)
  if (Array.isArray(s)) {
    console.log('search entries count:', s.length)
    console.log('first 3 search entries:', s.slice(0, 3))
  } else if (s && typeof s === 'object') {
    console.log('search keys:', Object.keys(s))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
