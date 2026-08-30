/**
 * Self-check for the block menu (Task 2.4 of the notion-parity proposal).
 *
 * Static assertions over the source:
 *  - `Turn into` submenu contains `Page` and the new block kinds
 *    (`Toggle list`, `Callout`).
 *  - The top-level flat list does NOT contain `Copy link to block`
 *    or the `Open in *` items (they moved to a dedicated `Link`
 *    submenu).
 *  - A `Link` submenu exists in both `SubmenuLayout` and `FlatLayout`
 *    and is wired to `linkActions`.
 *
 * Run with `pnpm tsx scripts/check-block-menu.ts` or
 * `node --import tsx scripts/check-block-menu.ts`. Exit code 0 = pass.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.cwd(), 'components/workspace/block-menu.tsx')
const src = readFileSync(file, 'utf8')

const failures: string[] = []
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}`)
    failures.push(label)
  }
}

console.log('block-menu: Task 2.4 static check')

const TURN_INTO = src.match(/const TURN_INTO:[^]*?\n]/)?.toString() ?? ''
check('Turn into contains Page', /id: 'turn-into-page'[\s\S]*?label: 'Page'/.test(src))
check('Turn into contains Toggle list', /type: 'toggle_list'/.test(TURN_INTO) && /label: 'Toggle list'/.test(TURN_INTO))
check('Turn into contains Callout', /type: 'callout'/.test(TURN_INTO) && /label: 'Callout'/.test(TURN_INTO))

const topLevelMatch = src.match(/const topLevel: MenuAction\[\] = \[([\s\S]*?)\]/)
const topLevel = topLevelMatch?.[1] ?? ''
check(
  'top-level contains Duplicate + Delete',
  /duplicateAction/.test(topLevel) && /deleteAction/.test(topLevel)
)
check(
  'top-level does NOT contain copyLinkAction',
  !/copyLinkAction/.test(topLevel)
)
check(
  'top-level does NOT contain openItems',
  !/\.\.\.openItems/.test(topLevel)
)

check(
  'Link submenu present in SubmenuLayout',
  /linkActions: MenuAction\[\]/.test(src) &&
    /linkActions\.map/.test(src) &&
    /Menu\.Trigger[^]*?Link[^]*?▸/.test(src) &&
    /props\.linkActions\.length > 0[\s\S]*?Link[\s\S]*?props\.linkActions/.test(src)
)
check(
  'linkActions computed with copyLinkAction (when not disabled)',
  /linkActions: MenuAction\[\] = \[\s*\.\.\.\(copyLinkAction\.disabled/.test(src) ||
    /linkActions: MenuAction\[\] = \[\s*\.\.\.\(copyLinkAction\.disabled \? \[\] : \[copyLinkAction\]\)/.test(src)
)

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
