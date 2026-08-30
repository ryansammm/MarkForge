/**
 * Self-check for the desktop tab bar (Task 14 of the notion-parity proposal).
 *
 * Static + behavioural assertions:
 *  - `lib/desktop-tabs.ts` is a pure reducer: open activates an existing
 *    tab, opens a new one at the cap, and refuses past the cap.
 *  - close / activate / reorder mutate the strip and respect the active-id.
 *  - The reducer exports `MAX_DESKTOP_TABS = 6` and `EMPTY_DESKTOP_TABS`.
 *  - The strip + popover are wired in `workspace-app.tsx`.
 *
 * Run with `pnpm tsx scripts/check-desktop-tabs.ts`. Exit 0 = pass.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyDesktopTabAction,
  EMPTY_DESKTOP_TABS,
  MAX_DESKTOP_TABS,
  activeDesktopPath,
  type DesktopTabAction,
  type DesktopTabsState,
} from '../lib/desktop-tabs'

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
let idCounter = 0
const nextId = () => `t${++idCounter}`

function apply(state: DesktopTabsState, action: DesktopTabAction): DesktopTabsState | null {
  return applyDesktopTabAction(state, action, nextId)
}

console.log('desktop tab bar: Task 14 check')

// --- exports -------------------------------------------------------------

check('MAX_DESKTOP_TABS is 6', MAX_DESKTOP_TABS === 6)
check('EMPTY_DESKTOP_TABS has no tabs', EMPTY_DESKTOP_TABS.tabs.length === 0 && EMPTY_DESKTOP_TABS.activeId === null)

// --- open -----------------------------------------------------------------

{
  const s1 = apply(EMPTY_DESKTOP_TABS, { type: 'open', path: 'a.md' })
  check('open: first tab becomes active', s1 !== null && s1.tabs.length === 1 && s1.activeId === s1.tabs[0].id)
  check('open: stores the path', s1 !== null && s1.tabs[0].path === 'a.md')
  check('activeDesktopPath returns the active path', s1 !== null && activeDesktopPath(s1) === 'a.md')
}

{
  // Open activates an existing tab
  const s1 = apply(EMPTY_DESKTOP_TABS, { type: 'open', path: 'a.md' })!
  const s2 = apply(s1, { type: 'open', path: 'b.md' })!
  const s3 = apply(s2, { type: 'open', path: 'a.md' })
  check('open: re-opening an existing path activates it', s3 !== null && s3.activeId === s3.tabs[0].id)
  check('open: re-opening does not duplicate the tab', s3 !== null && s3.tabs.length === 2)
}

{
  // Limit
  let s: DesktopTabsState = EMPTY_DESKTOP_TABS
  for (let i = 0; i < MAX_DESKTOP_TABS; i++) {
    const next = apply(s, { type: 'open', path: `p${i}.md` })
    check(`open: tab #${i + 1} opens`, next !== null)
    s = next!
  }
  const refused = apply(s, { type: 'open', path: 'overflow.md' })
  check('open: at the cap, the open is refused (null)', refused === null)
}

// --- close ----------------------------------------------------------------

{
  const s1 = apply(EMPTY_DESKTOP_TABS, { type: 'open', path: 'a.md' })!
  const s2 = apply(s1, { type: 'open', path: 'b.md' })!
  const s3 = apply(s2, { type: 'open', path: 'c.md' })!
  // active is c
  const s4 = apply(s3, { type: 'close', id: s3.tabs.find((t) => t.path === 'b.md')!.id })
  check('close: middle tab removed', s4 !== null && s4.tabs.length === 2)
  // active was c, c is still in the list, focus stays
  check('close: closing non-active keeps active', s4 !== null && activeDesktopPath(s4) === 'c.md')
  const s5 = apply(s3, { type: 'close', id: s3.activeId! })
  check('close: closing active falls back to right neighbour', s5 !== null && activeDesktopPath(s5) === 'b.md')
  // last tab
  const s6 = apply(apply(EMPTY_DESKTOP_TABS, { type: 'open', path: 'only.md' })!, { type: 'close', id: 'anything' })
  check('close: ignoring unknown id is a no-op', s6 !== null && s6.tabs.length === 1)
  const s7 = apply(s1, { type: 'close', id: s1.activeId! })
  check('close: removing the only tab returns empty', s7 !== null && s7.tabs.length === 0 && s7.activeId === null)
}

// --- activate -------------------------------------------------------------

{
  const s1 = apply(EMPTY_DESKTOP_TABS, { type: 'open', path: 'a.md' })!
  const s2 = apply(s1, { type: 'open', path: 'b.md' })!
  const s3 = apply(s2, { type: 'activate', id: s2.tabs[0].id })
  check('activate: switches active id', s3 !== null && activeDesktopPath(s3) === 'a.md')
  const s4 = apply(s2, { type: 'activate', id: 'no-such-tab' })
  check('activate: unknown id is a no-op', s4 !== null && s4 === s2)
}

// --- reorder --------------------------------------------------------------

{
  const s1 = apply(EMPTY_DESKTOP_TABS, { type: 'open', path: 'a.md' })!
  const s2 = apply(s1, { type: 'open', path: 'b.md' })!
  const s3 = apply(s2, { type: 'reorder', from: 0, to: 1 })
  check('reorder: swaps tabs', s3 !== null && s3.tabs[0].path === 'b.md' && s3.tabs[1].path === 'a.md')
  const s4 = apply(s2, { type: 'reorder', from: 0, to: 0 })
  check('reorder: same position is a no-op', s4 !== null && s4 === s2)
  const s5 = apply(s2, { type: 'reorder', from: 5, to: 0 })
  check('reorder: out-of-range is a no-op', s5 !== null && s5 === s2)
}

// --- wiring ---------------------------------------------------------------

const tabBar = readFileSync(resolve(root, 'components/workspace/desktop-tab-bar.tsx'), 'utf8')
const popover = readFileSync(resolve(root, 'components/workspace/page-picker-popover.tsx'), 'utf8')
const workspaceApp = readFileSync(resolve(root, 'components/workspace/workspace-app.tsx'), 'utf8')
const reducer = readFileSync(resolve(root, 'lib/desktop-tabs.ts'), 'utf8')

check('lib/desktop-tabs.ts exports applyDesktopTabAction', /export function applyDesktopTabAction\b/.test(reducer))
check('lib/desktop-tabs.ts exports MAX_DESKTOP_TABS', /export const MAX_DESKTOP_TABS\b/.test(reducer))
check('lib/desktop-tabs.ts exports EMPTY_DESKTOP_TABS', /export const EMPTY_DESKTOP_TABS\b/.test(reducer))
check('lib/desktop-tabs.ts exports activeDesktopPath', /export function activeDesktopPath\b/.test(reducer))

check('DesktopTabBar component is exported', /export function DesktopTabBar\b/.test(tabBar))
check('DesktopTabBar is hidden in web mode', /if \(!isDesktop\) return null/.test(tabBar))
check('DesktopTabBar renders the + button', /data-desktop-tab-add/.test(tabBar))
check('DesktopTabBar disables + at the cap', /disabled=\{state\.tabs\.length >= limit\}/.test(tabBar))
check('DesktopTabBar renders close × on each tab', /aria-label="Close tab"/.test(tabBar))

check('PagePickerPopover component is exported', /export function PagePickerPopover\b/.test(popover))
check('PagePickerPopover filters by title', /doc\.title\.toLowerCase\(\)\.includes\(q\)/.test(popover))
check('PagePickerPopover shows "No matches" when empty', /No matches/.test(popover))
check('PagePickerPopover dismisses on Escape', /event\.key === ['"]Escape['"]/.test(popover))

check(
  'workspace-app wires DesktopTabBar above the sidebar',
  /<DesktopTabBar[\s\S]*<\/div>/.test(workspaceApp)
)
check(
  'workspace-app passes dispatch + state to the bar',
  /state=\{desktopTabsState\}[\s\S]*dispatch=\{dispatchDesktopTabs\}/.test(workspaceApp)
)
check(
  'workspace-app passes onLimitReached toast',
  /onLimitReached=\{\(\) => toast\.error\(/.test(workspaceApp)
)
check(
  'workspace-app imports applyDesktopTabAction + MAX_DESKTOP_TABS',
  /applyDesktopTabAction/.test(workspaceApp) && /MAX_DESKTOP_TABS/.test(workspaceApp)
)
check(
  'workspace-app mirrors new-tab opens into the desktop strip',
  /if \(intent\.newTab\) dispatchDesktopTabs\(\{ type: 'open', path \}\)/.test(workspaceApp)
)

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
