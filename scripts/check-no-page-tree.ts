/**
 * Self-check for Task 4 of the notion-parity proposal: the sidebar no
 * longer mounts `PageTree`. Asserts:
 *
 *  - `components/workspace/page-tree.tsx` is gone.
 *  - `components/workspace/sidebar.tsx` does not import or render
 *    `PageTree` / `PageTreeProps`.
 *
 * Run with `pnpm tsx scripts/check-no-page-tree.ts`. Exit 0 = pass.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const failures: string[] = []
function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra ? `  (${extra})` : ''}`)
    failures.push(label)
  }
}

console.log('sidebar: Task 4.5 — page-tree removed')

const pageTreePath = resolve(root, 'components/workspace/page-tree.tsx')
check(
  'components/workspace/page-tree.tsx is deleted',
  !existsSync(pageTreePath)
)

const sidebarPath = resolve(root, 'components/workspace/sidebar.tsx')
const sidebar = readFileSync(sidebarPath, 'utf8')
check(
  'sidebar does not import PageTree',
  !/import\s+\{[^}]*PageTree[^}]*\}\s+from\s+['"][^'"]*page-tree['"]/.test(sidebar),
  sidebar.match(/import.*page-tree.*\n/)?.[0] ?? ''
)
check(
  'sidebar does not reference <PageTree',
  !/<PageTree\b/.test(sidebar)
)
check(
  'sidebar no longer has the Documents section heading',
  !/Documents<\/span>/.test(sidebar)
)

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
