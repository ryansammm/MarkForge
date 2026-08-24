'use strict'

/**
 * electron-builder afterPack hook.
 *
 * Menyalin Next standalone server ke dalam resources aplikasi. Dilakukan di sini
 * (bukan lewat extraFiles) karena electron-builder menyaring direktori
 * berawalan titik seperti .next - penyebab resources/server tidak pernah muncul
 * dan app.asar membengkak saat konfigurasi tidak terbaca.
 */

const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const projectDir = context.packager.projectDir
  const appOutDir = context.appOutDir
  const resourcesDir = path.join(appOutDir, 'resources')
  const serverDest = path.join(resourcesDir, 'server')

  const copyStep = (label, from, to) => {
    console.log(`[after-pack] ${label}`)
    fs.cpSync(from, to, { recursive: true })
  }

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
      const dest = path.join(serverDest, 'node_modules', m[1], m[2])
      fs.cpSync(pkgDir, dest, { recursive: true })
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
