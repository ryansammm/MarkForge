import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Build portable exe end-to-end.
 *
 * Penyalinan folder standalone TIDAK dilakukan manual di sini (cpSync Node
 * terbukti mati diam-diam di runner Windows CI). electron-builder yang menyalin,
 * lewat mapping extraFiles di electron-builder.yml - jalur yang sama dipakai
 * ribuan project Next standalone + Electron.
 *
 * Yang disiapkan skrip ini: build standalone + file .env penanda untuk
 * extraFiles (wajib ada agar electron-builder tidak error).
 */

function run(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  })
  if (res.status !== 0) {
    console.error(`step failed: ${cmd} ${args.join(' ')}`)
    process.exit(res.status ?? 1)
  }
}

run('pnpm', ['build'], { BUILD_FOR_ELECTRON: '1' })

// Marker .env untuk extraFiles (isi dari repo .env kalau ada)
const markerDir = path.join(process.cwd(), '.next', 'electron-build')
fs.mkdirSync(markerDir, { recursive: true })
const envTarget = path.join(markerDir, '.env')
if (fs.existsSync('.env')) fs.copyFileSync('.env', envTarget)
else fs.writeFileSync(envTarget, '')

run('pnpm', ['exec', 'electron-builder', '--win', '--x64'])

console.log('\nDone. Portable exe is in dist/')
