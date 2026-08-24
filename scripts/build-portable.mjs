import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Builds the portable exe end-to-end:
 *   1. next build with standalone output (BUILD_FOR_ELECTRON=1)
 *   2. assemble .next/electron-build (server + static + public + .env)
 *   3. electron-builder --win portable -> dist/MarkForge-Portable-<ver>.exe
 *
 * Env injection is done here rather than in package.json because Windows cmd
 * cannot set a per-command environment variable.
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
run('node', ['scripts/prepare-electron.mjs'])
run('pnpm', ['exec', 'electron-builder', '--win', '--x64'])

console.log('\nDone. Portable exe is in dist/')
