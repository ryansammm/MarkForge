import { spawn } from 'node:child_process'
import fs from 'node:fs'

/**
 * Boot standalone server.js langsung (system node) untuk verifikasi cepat:
 * semua module harus resolve sebelum dieksekusi packaging electron-builder.
 */
const port = process.env.PORT || '3460'
const env = {
  ...process.env,
  PORT: port,
  NODE_ENV: 'production',
  NOTES_DIR: process.env.APPDATA + '\\MarkForge\\notes',
  META_DIR: process.env.APPDATA + '\\MarkForge\\meta',
}

const child = spawn(process.execPath, ['.next/standalone/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const deadline = Date.now() + 15000
let ok = false
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    if (res.ok) {
      ok = true
      break
    }
  } catch {}
}
console.log('standalone boot:', ok ? 'OK' : 'GAGAL')
console.log('--- output server ---')
console.log(out.slice(0, 1200))
child.kill('SIGKILL')
process.exit(ok ? 0 : 1)
