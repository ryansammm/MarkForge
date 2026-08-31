/**
 * Self-check for the unique-name retry in `createDocumentAt`.
 *
 * Before the fix, clicking "New page" twice in a row threw
 * `Untitled.md already exists`. `findUniquePath` walks the in-memory
 * index and bumps the trailing number until it lands on a free name.
 *
 * Run with `pnpm tsx scripts/check-unique-name.ts`. Exit 0 = pass.
 */
import { findUniquePath } from '../lib/workspace-api'

const failures: string[] = []
function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra ? `  (${extra})` : ''}`)
    failures.push(label)
  }
}

console.log('unique-name retry: check')

check('Untitled.md when nothing is taken', findUniquePath('', 'Untitled', []) === 'Untitled.md')
check('Untitled 2.md when Untitled.md is taken', findUniquePath('', 'Untitled', ['Untitled.md']) === 'Untitled 2.md')
check('Untitled 3.md when 1 and 2 are taken', findUniquePath('', 'Untitled', ['Untitled.md', 'Untitled 2.md']) === 'Untitled 3.md')
check('namespaced in a sub-folder', findUniquePath('Notes', 'Inbox', ['Notes/Inbox.md']) === 'Notes/Inbox 2.md')
check('the workspace has a flat namespace so any X.md anywhere bumps', findUniquePath('Notes', 'Inbox', ['Archive/Inbox.md']) === 'Notes/Inbox 2.md')
check('a single taken path under a different folder still bumps', findUniquePath('', 'X', ['a/X.md']) === 'X 2.md')
check('collision count climbs to 5', findUniquePath('', 'T', ['T.md', 'T 2.md', 'T 3.md', 'T 4.md']) === 'T 5.md')

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
