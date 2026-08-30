/**
 * Self-check for Task 15 of the notion-parity proposal: drop offline mode.
 *
 * Static assertions:
 *  - `MarkForge-Offline.bat` is gone.
 *  - `MarkForge.bat` exists, `MarkForge-Online.bat` is gone.
 *  - No source file (or the `.bat`/`.cjs` config) contains
 *    `MARKFORGE_OFFLINE` or `MARKFORGE_ONLINE`.
 *  - `electron/main.cjs` does not branch on either env var, and
 *    the `localOnly` pin-off block is gone.
 *
 * Run with `pnpm tsx scripts/check-no-offline.ts`. Exit 0 = pass.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const failures: string[] = []
function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra ? `  (${extra})` : ''}`)
    failures.push(label)
  }
}

const root = resolve(process.cwd())

console.log('drop offline mode: Task 15 check')

// --- launcher files ------------------------------------------------------

check('MarkForge-Offline.bat is deleted', !existsSync(join(root, 'MarkForge-Offline.bat')))
check('MarkForge-Online.bat is deleted', !existsSync(join(root, 'MarkForge-Online.bat')))
check('MarkForge.bat exists', existsSync(join(root, 'MarkForge.bat')))
{
  const bat = readFileSync(join(root, 'MarkForge.bat'), 'utf8')
  check('MarkForge.bat does not set MARKFORGE_ONLINE', !/MARKFORGE_ONLINE/.test(bat))
  check('MarkForge.bat does not set MARKFORGE_OFFLINE', !/MARKFORGE_OFFLINE/.test(bat))
  check('MarkForge.bat calls pnpm desktop:start', /pnpm desktop:start/.test(bat))
}

// --- electron/main.cjs ---------------------------------------------------

const main = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8')
check('main.cjs does not mention MARKFORGE_ONLINE', !/MARKFORGE_ONLINE/.test(main))
check('main.cjs does not mention MARKFORGE_OFFLINE', !/MARKFORGE_OFFLINE/.test(main))
check('main.cjs no longer has the localOnly block', !/localOnly/.test(main))
check(
  'main.cjs dev-spawn uses process.env directly',
  /env: \{ \.\.\.process\.env, NOTES_DIR: NOTES_DIR, META_DIR: META_DIR \}/.test(main)
)

// --- repo-wide scan for the dead env vars --------------------------------

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.bat', '.cmd', '.json', '.md'])
const SCAN_SKIP = new Set(['node_modules', '.next', 'dist', '.git', '.opencode', 'backups', 'logs'])

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SCAN_SKIP.has(entry.name)) continue
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot === -1) continue
    const ext = entry.name.slice(dot)
    if (!SCAN_EXTS.has(ext)) continue
    out.push(full)
  }
}

const files: string[] = []
walk(root, files)

function isInOpenspec(file: string): boolean {
  return file.includes(`${sep}openspec${sep}`) || file.includes('/openspec/')
}

const DEAD_NEEDLES = ['MARKFORGE_OFFLINE', 'MARKFORGE_ONLINE']
const deadHits: { path: string; needle: string }[] = []
for (const file of files) {
  // Specs and this self-check may keep the names in prose.
  if (isInOpenspec(file)) continue
  if (file.endsWith('check-no-offline.ts')) continue
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const needle of DEAD_NEEDLES) {
    if (text.includes(needle)) deadHits.push({ path: file, needle })
  }
}
if (deadHits.length === 0) {
  check('no source file references MARKFORGE_OFFLINE / MARKFORGE_ONLINE', true)
} else {
  for (const hit of deadHits) {
    console.log(`  FAIL  ${hit.path} references ${hit.needle}`)
    failures.push(`${hit.path} references ${hit.needle}`)
  }
}

const localOnlyHits: string[] = []
for (const file of files) {
  if (isInOpenspec(file)) continue
  if (file.endsWith('check-no-offline.ts')) continue
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (/localOnly/.test(text)) localOnlyHits.push(file)
}
if (localOnlyHits.length === 0) {
  check('no source file references localOnly', true)
} else {
  for (const f of localOnlyHits) {
    console.log(`  FAIL  ${f} references localOnly`)
    failures.push(`${f} references localOnly`)
  }
}

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
