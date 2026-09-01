import { spawnSync } from 'node:child_process'

/**
 * Build portable exe end-to-end.
 *
 * Dipanggil dari `scripts\build-portable.bat` (double-click). Tidak ada
 * `dist:portable` di package.json — build ini on-demand, bukan jalur
 * Vercel (Vercel deploy `.next/standalone` langsung).
 *
 * 1. next build dengan output standalone (BUILD_FOR_ELECTRON=1)
 * 2. electron-builder portable - penyalinan server ke resources dilakukan
 *    hook afterPack (scripts/after-pack.cjs), bukan cpSync manual.
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
run('pnpm', ['exec', 'electron-builder', '--win', '--x64'])

console.log('\nDone. Portable exe is in dist/')
