/**
 * Self-check for the sidebar `+` popover and the right-click page context
 * menu (Task 13 of the notion-parity proposal).
 *
 *  - `components/workspace/sidebar-plus-popover.tsx` renders a single `+`
 *    trigger and a popover with two items: `New page` and `New grimoire`.
 *  - `components/workspace/sidebar-page-context-menu.tsx` renders two
 *    items: `Open in side peek` (always) and `Open in new window`
 *    (web only, hidden behind `!isDesktop`).
 *  - `components/workspace/sidebar.tsx` mounts both and wires them.
 *  - `components/workspace/grimoire-switcher.tsx` exposes a
 *    `requestCreate` imperative handle for the popover to call.
 *  - The block-menu's existing `OpenTarget` enum has `side-peek` and
 *    `new-window`; the sidebar context menu reuses the same names.
 *
 * Run with `pnpm tsx scripts/check-sidebar-plus.ts`. Exit 0 = pass.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

const popover = readFileSync(resolve(root, 'components/workspace/sidebar-plus-popover.tsx'), 'utf8')
const ctxMenu = readFileSync(resolve(root, 'components/workspace/sidebar-page-context-menu.tsx'), 'utf8')
const sidebar = readFileSync(resolve(root, 'components/workspace/sidebar.tsx'), 'utf8')
const switcher = readFileSync(resolve(root, 'components/workspace/grimoire-switcher.tsx'), 'utf8')
const blockMenu = readFileSync(resolve(root, 'components/workspace/block-menu.tsx'), 'utf8')
const workspaceApp = readFileSync(resolve(root, 'components/workspace/workspace-app.tsx'), 'utf8')

console.log('sidebar plus / page context menu: Task 13 check')

// --- SidebarPlusPopover ---------------------------------------------------

check('SidebarPlusPopover component is exported', /export function SidebarPlusPopover\b/.test(popover))
check('popover trigger has aria-haspopup="menu"', /aria-haspopup="menu"/.test(popover))
check('popover has two items: "New page" and "New grimoire"', />New page</.test(popover) && />New grimoire</.test(popover))
check('popover closes on Escape', /event\.key === ['"]Escape['"]/.test(popover))
check('popover closes on outside mousedown', /addEventListener\(['"]mousedown['"]/.test(popover))

// --- SidebarPageContextMenu ----------------------------------------------

check('SidebarPageContextMenu component is exported', /export function SidebarPageContextMenu\b/.test(ctxMenu))
check('context menu item: "Open in side peek"', />Open in side peek</.test(ctxMenu))
check('context menu item: "Open in new window"', />Open in new window</.test(ctxMenu))
check('"Open in new window" hidden when isDesktop is true', /!isDesktop/.test(ctxMenu))
check('context menu positions to viewport coordinates', /position\.x/.test(ctxMenu) && /position\.y/.test(ctxMenu))
check('context menu keeps inside viewport on bottom-right', /viewportW|window\.innerWidth/.test(ctxMenu))

// --- GrimoireSwitcher forwardRef -----------------------------------------

check('GrimoireSwitcher uses forwardRef', /forwardRef</.test(switcher))
check('GrimoireSwitcherHandle type exports requestCreate', /requestCreate: \(\) => void/.test(switcher))
check(
  'requestCreate opens the dropdown + create input',
  /requestCreate\(\) \{[\s\S]*setOpen\(true\)[\s\S]*setCreating\(true\)/.test(switcher)
)

// --- Sidebar wiring ------------------------------------------------------

check('sidebar imports SidebarPlusPopover', /SidebarPlusPopover/.test(sidebar))
check('sidebar imports SidebarPageContextMenu', /SidebarPageContextMenu/.test(sidebar))
check('sidebar imports GrimoireSwitcherHandle', /GrimoireSwitcherHandle/.test(sidebar))
check('sidebar renders <SidebarPlusPopover>', /<SidebarPlusPopover\b/.test(sidebar))
check('sidebar renders <SidebarPageContextMenu>', /<SidebarPageContextMenu\b/.test(sidebar))
check('sidebar passes ref to <GrimoireSwitcher ref={grimoireSwitcherRef}>', /ref=\{grimoireSwitcherRef\}/.test(sidebar))
check('sidebar has grimoireSwitcherRef handle', /grimoireSwitcherRef\s*=\s*useRef<GrimoireSwitcherHandle>/.test(sidebar))
check('sidebar right-click handler on document row', /onContextMenu/.test(sidebar))
check('sidebar tracks context menu state', /setContextMenu\(/.test(sidebar))
check('sidebar accepts onCreatePageDirect prop', /onCreatePageDirect\??: \(\) => void/.test(sidebar))
check('sidebar accepts onOpenInSidePeek prop', /onOpenInSidePeek\??: \(path: string\) => void/.test(sidebar))
check('sidebar accepts onOpenInNewWindow prop', /onOpenInNewWindow\??: \(path: string\) => void/.test(sidebar))

// --- workspace-app wiring ------------------------------------------------

check(
  'workspace-app wires onCreatePageDirect to createDocumentAt',
  /onCreatePageDirect=\{\(\) => void createDocumentAt\(/.test(workspaceApp)
)
check('workspace-app wires onOpenInSidePeek', /onOpenInSidePeek=\{\(path\) =>/.test(workspaceApp))
check('workspace-app wires onOpenInNewWindow', /onOpenInNewWindow=\{\(path\) =>/.test(workspaceApp))
check(
  'workspace-app new-window path uses window.markforge.openInWindow first',
  /window\.markforge/.test(workspaceApp) && /openInWindow/.test(workspaceApp)
)
check(
  'workspace-app new-window web fallback reuses tab reducer',
  /dispatchTabs\(\{ type: 'open', path, newTab: true/.test(workspaceApp)
)

// --- Block-menu OpenTarget enum contract ---------------------------------

check('block-menu still defines OpenTarget', /OpenTarget/.test(blockMenu))
check('OpenTarget includes side-peek and new-window', /side-peek/.test(blockMenu) && /new-window/.test(blockMenu))

if (failures.length === 0) {
  console.log('\nALL OK')
  process.exit(0)
}
console.error(`\n${failures.length} failure(s):`)
for (const f of failures) console.error(`  - ${f}`)
process.exit(1)
