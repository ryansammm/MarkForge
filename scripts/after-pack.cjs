'use strict'

/**
 * electron-builder afterPack hook.
 *
 * Menyalin Next standalone server ke dalam resources aplikasi. Dilakukan di sini
 * (bukan lewat extraFiles) karena electron-builder menyaring direktori
 * berawalan titik seperti .next - penyebab resources/server tidak pernah muncul
 * dan app.asar membengkak saat konfigurasi tidak terbaca.
 *
 * Pohon besar disalin via robocopy, bukan fs.cpSync: cpSync memakan memori
 * sebanding ukuran pohon dan pernah membuat job CI mati DIAM (exit 1 tanpa
 * pesan, pola OOM-kill) di tengah penyalinan. Robocopy = proses eksternal,
 * memori konstan, cepat, tahan path panjang. Kode keluar 0-7 = sukses.
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function robocopy(from, to) {
  // /R:10 /W:5: runner CI Windows sering mengunci file baru (AV scan) —
  // retry pendek bikin ERROR 5 Access denied palsu. 10x5 dtk cukup longgar.
  return execFileSync(
    'robocopy',
    [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:10', '/W:5'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  )
}

function copyStep(label, from, to) {
  console.log(`[after-pack] ${label}`)
  try {
    robocopy(from, to)
  } catch (e) {
    // PENTING: robocopy sukses = kode keluar 0..7 (bitmask: 1 file tersalin,
    // 2 ada ekstra di tujuan, dst). execFileSync melempar untuk SEMUA non-nol,
    // jadi tangkap dan terima 0..7; baru gagal sungguhan kalau >= 8.
    const status = e.status ?? -1
    if (status >= 0 && status <= 7) return
    const out = String(e.stdout || e.message || '').slice(-1500)
    throw new Error(`robocopy gagal (${status}): ${from} -> ${to}\n${out}`)
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const projectDir = context.packager.projectDir
  const appOutDir = context.appOutDir
  const resourcesDir = path.join(appOutDir, 'resources')
  const serverDest = path.join(resourcesDir, 'server')

  const standalone = path.join(projectDir, '.next', 'standalone')
  if (!fs.existsSync(path.join(standalone, 'server.js'))) {
    throw new Error(
      '.next/standalone/server.js tidak ditemukan - jalankan build dengan BUILD_FOR_ELECTRON=1 (scripts/build-portable.mjs)'
    )
  }

  console.log(`[after-pack] menyalin standalone server -> ${path.relative(projectDir, serverDest)}`)
  fs.rmSync(serverDest, { recursive: true, force: true })
  copyStep('copy standalone', standalone, serverDest)

  copyStep(
    'copy static chunks',
    path.join(projectDir, '.next', 'static'),
    path.join(serverDest, '.next', 'static')
  )

  copyStep('copy public', path.join(projectDir, 'public'), path.join(serverDest, 'public'))

  /*
    Keluarga AWS SDK (@aws-sdk/*, @smithy/*): NFT tracing melewatkan dependensi
    transitive-nya saat layout pnpm-hoisted (client-s3 di-externalize tanpa closure),
    sehingga runtime melempar "Cannot find module '@aws-sdk/core'" dsb. Sumber kebenaran
    versi-consistent: virtual store .pnpm milik lockfile yang sama. Disalin apa adanya
    ke node_modules standalone.
  */
  const pnpmStore = path.join(projectDir, 'node_modules', '.pnpm')
  const families = ['@aws-sdk', '@smithy', '@aws']
  let copied = 0
  if (fs.existsSync(pnpmStore)) {
    for (const entry of fs.readdirSync(pnpmStore)) {
      // entri berformat "@scope+name@version" atau "name@version"
      const m = entry.match(/^(@[^+]+)\+(.+)@/)
      if (!m || !families.includes(m[1])) continue
      const pkgDir = path.join(pnpmStore, entry, 'node_modules', m[1], m[2])
      if (!fs.existsSync(pkgDir)) continue
      copyStep(`supplement ${m[1]}/${m[2]}`, pkgDir, path.join(serverDest, 'node_modules', m[1], m[2]))
      copied++
    }
    console.log(`[after-pack] ${copied} paket AWS/Smithy disalin dari .pnpm`)
  } else {
    console.warn('[after-pack] node_modules/.pnpm tidak ditemukan - lewati supplement AWS SDK')
  }

  // .env opsional: cloud sync membutuhkannya; tanpa .env app tetap jalan lokal.
  const envSrc = path.join(projectDir, '.env')
  const envDest = path.join(resourcesDir, '.env')
  fs.writeFileSync(envDest, fs.existsSync(envSrc) ? fs.readFileSync(envSrc) : '')
  const envInServer = path.join(serverDest, '.env')
  fs.writeFileSync(envInServer, fs.existsSync(envSrc) ? fs.readFileSync(envSrc) : '')

  console.log('[after-pack] standalone server siap di resources/server')
}
