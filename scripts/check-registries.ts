import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { readFileSync } from 'fs'

const envLines = readFileSync('.env', 'utf-8').split('\n')
for (const line of envLines) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue
  const i = t.indexOf('='); if (i === -1) continue
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}

const c = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
})

async function main() {
  // Check R2 registry
  const r = await c.send(new GetObjectCommand({ Bucket: 'markdown', Key: '_meta/grimoires.json' }))
  const body = await r.Body.transformToString()
  console.log('=== R2 Registry ===')
  console.log(body)

  // Check local grimoires.json
  try {
    const local = readFileSync('grimoires.json', 'utf-8')
    console.log('\n=== Local Registry ===')
    console.log(local)
  } catch {
    console.log('\n=== Local Registry === (not found)')
  }
}

main()
