import fs from 'node:fs'
import path from 'node:path'

/**
 * Merakit folder yang dibundel ke dalam exe portable.
 *
 * Setiap operasi dicatat dan error dilempar dengan jelas - versi sebelumnya
 * gagal diam-diam di CI (exit 1 tanpa satu baris pun output), memakan satu
 * sesi debugging penuh hanya untuk menemukan TITIK kegagalannya.
 */

const root = process.cwd()
const out = path.join(root, '.next', 'electron-build')
const step = (msg) => console.log(`[prepare] ${msg}`)

function guard(label, fn) {
  try {
    fn()
  } catch (err) {
    // Lempar, jangan process.exit: exit segera setelah menulis bisa kehilangan
    // output stderr di CI (race flush) - persis penyebab gagal-diam itu.
    console.error(`[prepare] GAGAL pada "${label}":`, err)
    throw err
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
  throw new Error('standalone output tidak tersedia - lihat diagnosa di atas')
}

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
  console.log('copied .env into build (secrets are baked into this exe)')
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
