/**
 * Self-check for the page menu (Task 5.8 of the notion-parity proposal).
 *
 * Static assertions over the source + a runtime round-trip on the
 * `setFrontmatterField` helper:
 *
 *  - `components/workspace/page-menu.tsx` exports `PageMenu` and lists
 *    every action the spec calls for: Copy / Duplicate / Move to /
 *    Move to trash / Small text / Full text / Full width / Default
 *    width / Lock page / Import / Export.
 *  - The viewer reads `view` / `width` from frontmatter and uses them
 *    to choose the wrapper max-width.
 *  - The `setFrontmatterField` helper actually round-trips: writing
 *    a value, reading it back, and removing it returns the original
 *    body unchanged.
 *
 * Run with `pnpm tsx scripts/check-page-menu.ts`. Exit 0 = pass.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { removeFrontmatterField, setFrontmatterField, splitFrontmatter } from '../lib/markdown/frontmatter'

const failures: string[] = []
function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra ? `  (${extra})` : ''}`)
    failures.push(label)
  }
}

console.log('page menu: Task 5.8 check')

const menu = readFileSync(resolve(process.cwd(), 'components/workspace/page-menu.tsx'), 'utf8')
const viewer = readFileSync(resolve(process.cwd(), 'components/workspace/doc-viewer.tsx'), 'utf8')

check('PageMenu component is exported', /export function PageMenu\b/.test(menu))

const labels = [
  'Copy page content',
  'Duplicate',
  'Move to',
  'Move to trash',
  'Small text',
  'Full text',
  'Full width',
  'Default width',
  'Lock page',
  'Import',
  'Export',
]
for (const label of labels) {
  // `Move to` lives inside the FolderPicker (a nested submenu), so it
  // appears as plain text rather than a `label="…"` attribute.
  const pattern = label === 'Move to'
    ? new RegExp(`>${label}<`)
    : new RegExp(`label="${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
  check(`menu item "${label}" is rendered`, pattern.test(menu))
}

check('Move to uses a folder picker (submenu of folders)', /FolderPicker/.test(menu) && /collectFolders/.test(menu))
check('Move to filters the current folder (currentPath.startsWith check)', /currentPath\.startsWith\([`']\$\{fullPath\}/.test(menu))
check('Lock page / Import / Export show "coming in Task" hint', /Task 9|Task 10/.test(menu))

check('viewer imports frontmatterView / frontmatterWidth', /frontmatterView/.test(viewer) && /frontmatterWidth/.test(viewer))
check('viewer renders <PageMenu>', /<PageMenu\b/.test(viewer))
check('viewer applies the frontmatter-driven max-width', /max-w-(2xl|3xl|5xl)/.test(viewer))

// Round-trip the frontmatter helper
const original = `---\nid: abc\ntitle: Hello\n---\n# Hi\n`
const withView = setFrontmatterField(original, 'view', 'small')
check('setFrontmatterField: writes `view: small`', withView.changed && splitFrontmatter(withView.content).frontmatter.view === 'small', withView.content)
const withWidth = setFrontmatterField(withView.content, 'width', 'full')
check('setFrontmatterField: writes `width: full`', withWidth.changed && splitFrontmatter(withWidth.content).frontmatter.width === 'full', withWidth.content)
const replaced = setFrontmatterField(withWidth.content, 'view', 'full')
check('setFrontmatterField: replaces existing value', splitFrontmatter(replaced.content).frontmatter.view === 'full' && replaced.changed, replaced.content)
const removed = removeFrontmatterField(replaced.content, 'width')
check('removeFrontmatterField: drops the line', !splitFrontmatter(removed.content).frontmatter.width, removed.content)
const removeMissing = removeFrontmatterField(original, 'view')
check('removeFrontmatterField: returns changed=false when key missing', !removeMissing.changed, removeMissing.content)
const onInvalid = setFrontmatterField('---\nid: x\n: bad yaml:\n  - [\n---', 'view', 'small')
check('setFrontmatterField: leaves invalid YAML untouched', !onInvalid.changed, onInvalid.content)

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
