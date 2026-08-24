import fs from 'node:fs'
import path from 'node:path'

/**
 * Merakit folder yang dibundel ke dalam exe portable.
 *
 * Pola kegagalan: setiap guard mencatat error dan MENANDAI gagal, lalu sisa
 * langkah dilewati dan proses berakhir natural dengan exitCode=1. Ini menjamin
 * log tersalurkan penuh (proses.exit segera setelah stderr terbukti kehilangan
 * pesan di GitHub Actions - race flush).
 */

const root = process.cwd()
const out = path.join(root, '.next', 'electron-build')
const step = (msg) => console.log(`[prepare] ${msg}`)

let failedStep = null

function guard(label, fn) {
  if (failedStep) return
  try {
    fn()
  } catch (err) {
    failedStep = `${label}: ${err?.message ?? err}`
    console.error(`[prepare] GAGAL pada "${label}":`, err)
  }
}

// Fail loudly with diagnostics: a silent exit-1 here cost a full debugging
// session on CI because nothing was printed at all.
const standaloneServer = path.join(root, '.next', 'standalone', 'server.js')
if (!fs.existsSync(standaloneServer)) {
  console.error('FATAL: .next/standalone/server.js tidak ditemukan.')
  console.error('Kemungkinan: next build dijalankan tanpa BUILD_FOR_ELECTRON=1,')
  console.error('atau versi Next/Turbopack tidak menghasilkan output standalone.')
  const dotNext = path.join(root, '.next')
  if (fs.existsSync(dotNext)) {
    console.error('Isi .next saat ini:', fs.readdirSync(dotNext).join(', ') || '(kosong)')
    const cfg = fs.readFileSync(path.join(root, 'next.config.mjs'), 'utf8')
    console.error('BUILD_FOR_ELECTRON env =', JSON.stringify(process.env.BUILD_FOR_ELECTRON))
    console.error(
      'next.config.mjs menyertakan output standalone:',
      cfg.includes("output: 'standalone'")
    )
  } else {
    console.error('.next tidak ada sama sekali - build belum dijalankan.')
  }
  process.exitCode = 1
} else {
  step('hapus hasil rakitan lama')
  guard('rmSync electron-build', () => fs.rmSync(out, { recursive: true, force: true }))

  step('salin .next/standalone -> electron-build/server')
  guard('cpSync standalone', () =>
    fs.cpSync(path.join(root, '.next', 'standalone'), path.join(out, 'server'), {
      recursive: true,
    })
  )

  step('salin .next/static -> server/.next/static')
  guard('cpSync static', () =>
    fs.cpSync(path.join(root, '.next', 'static'), path.join(out, 'server', '.next', 'static'), {
      recursive: true,
    })
  )

  step('salin public/ -> server/public')
  guard('cpSync public', () =>
    fs.cpSync(path.join(root, 'public'), path.join(out, 'server', 'public'), { recursive: true })
  )

  step('siapkan .env')
  if (fs.existsSync(path.join(root, '.env'))) {
    fs.copyFileSync(path.join(root, '.env'), path.join(out, '.env'))
    fs.copyFileSync(path.join(root, '.env'), path.join(out, 'server', '.env'))
    console.log('[prepare] copied .env into build (secrets are baked into this exe)')
  } else {
    // extraFiles requires the source to exist; an empty file keeps builds reproducible
    fs.writeFileSync(path.join(out, '.env'), '')
    fs.writeFileSync(path.join(out, 'server', '.env'), '')
  }

  let total = 0
  function size(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) size(p)
      else total += fs.statSync(p).size
    }
  }
  step('hitung ukuran')
  guard('size walk', () => size(out))
  console.log('[prepare] electron-build assembled:', (total / 1024 / 1024).toFixed(1) + ' MB')

  if (failedStep) {
    console.error(`[prepare] SELESAI DENGAN KEGAGALAN pada: ${failedStep}`)
    process.exitCode = 1
  }
}
