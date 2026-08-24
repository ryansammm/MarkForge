import fs from 'node:fs'
import path from 'node:path'

/**
 * Assembles the folder that gets bundled into the portable exe.
 *
 * `next build` with BUILD_FOR_ELECTRON=1 emits .next/standalone (server.js +
 * exactly the node_modules the server traces). The standalone layout still needs
 * the browser-side static chunks and public assets copied in - the documented
 * manual step for standalone deployments, done here so nobody has to remember it.
 *
 * Also copies the repo .env next to the server so cloud sync works out of the
 * box on the developer's own machine. NOTE: that bakes secrets into the build
 * output; never distribute your personal exe to other people.
 */

const root = process.cwd()
const out = path.join(root, '.next', 'electron-build')

// Fail loudly with diagnostics: a silent exit-1 here cost a full debugging
// session on CI because nothing was printed at all.
const standaloneServer = path.join(root, '.next', 'standalone', 'server.js')
if (!fs.existsSync(standaloneServer)) {
  console.error('FATAL: .next/standalone/server.js tidak ditemukan.')
  console.error('Kemungkinan: next build dijalankan tanpa BUILD_FOR_ELECTRON=1,')
  console.error('atau versi Next/Turbopack tidak menghasilkan output standalone.')
  const dotNext = path.join(root, '.next')
  if (fs.existsSync(dotNext)) {
    const names = fs.readdirSync(dotNext).join(', ')
    console.error('Isi .next saat ini:', names || '(kosong)')
    const cfg = fs.readFileSync(path.join(root, 'next.config.mjs'), 'utf8')
    console.error('BUILD_FOR_ELECTRON env =', JSON.stringify(process.env.BUILD_FOR_ELECTRON))
    console.error('next.config.mjs menyertakan output standalone:', cfg.includes("output: 'standalone'"))
  } else {
    console.error('.next tidak ada sama sekali - build belum dijalankan.')
  }
  process.exit(1)
}

fs.rmSync(out, { recursive: true, force: true })
fs.cpSync(path.join(root, '.next', 'standalone'), path.join(out, 'server'), { recursive: true })
fs.cpSync(path.join(root, '.next', 'static'), path.join(out, 'server', '.next', 'static'), {
  recursive: true,
})
fs.cpSync(path.join(root, 'public'), path.join(out, 'server', 'public'), { recursive: true })

if (fs.existsSync(path.join(root, '.env'))) {
  fs.copyFileSync(path.join(root, '.env'), path.join(out, '.env'))
  fs.copyFileSync(path.join(root, '.env'), path.join(out, 'server', '.env'))
  console.log('copied .env into build (secrets are baked into this exe)')
} else {
  // extraFiles requires the source to exist; an empty file keeps builds reproducible
  fs.writeFileSync(path.join(out, '.env'), '')
  fs.writeFileSync(path.join(out, 'server', '.env'), '')
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
let total = 0
function size(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) size(p)
    else total += fs.statSync(p).size
  }
}
size(out)
console.log('electron-build assembled:', mb(total))
