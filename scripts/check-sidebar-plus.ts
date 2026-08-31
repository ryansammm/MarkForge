/**
 * Self-check for the sidebar's create actions and the right-click page
 * context menu (Task 13 of the notion-parity proposal, plus a follow-up
 * swap of the `+` popover for two side-by-side icon buttons).
 *
 *  - `components/workspace/sidebar.tsx` renders two icon buttons in the
 *    Folders header: `New page` (FilePlus) and `New grimoire`
 *    (FolderPlus). No popover.
 *  - `components/workspace/sidebar-page-context-menu.tsx` renders two
 *    items: `Open in side peek` (always) and `Open in new window`
 *    (web only, hidden behind `!isDesktop`).
 *  - `components/workspace/sidebar.tsx` mounts the context menu and wires
 *    it.
 *  - `components/workspace/grimoire-switcher.tsx` exposes a
 *    `requestCreate` imperative handle so the sidebar can jump to the
 *    create form without opening the dropdown.
 *  - `Cmd/Ctrl-Shift-N` reaches the same `requestCreate` via the shortcut
 *    bus in `lib/shortcut-bus.ts`, not through a ref plumbed into
 *    `workspace-app.tsx`.
 *  - The block-menu's existing `OpenTarget` enum has `side-peek` and
 *    `new-window`; the sidebar context menu reuses the same names.
 *
 * Run with `pnpm tsx scripts/check-sidebar-plus.ts`. Exit 0 = pass.
 */
import { readFileSync, existsSync } from 'node:fs'
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

const ctxMenu = readFileSync(resolve(root, 'components/workspace/sidebar-page-context-menu.tsx'), 'utf8')
const sidebar = readFileSync(resolve(root, 'components/workspace/sidebar.tsx'), 'utf8')
const switcher = readFileSync(resolve(root, 'components/workspace/grimoire-switcher.tsx'), 'utf8')
const blockMenu = readFileSync(resolve(root, 'components/workspace/block-menu.tsx'), 'utf8')
const workspaceApp = readFileSync(resolve(root, 'components/workspace/workspace-app.tsx'), 'utf8')
const shortcutBus = readFileSync(resolve(root, 'lib/shortcut-bus.ts'), 'utf8')

console.log('sidebar create actions / page context menu: Task 13 check')

// --- Popover removed in favour of two icon buttons -----------------------

check(
  'sidebar-plus-popover.tsx is gone',
  !existsSync(resolve(root, 'components/workspace/sidebar-plus-popover.tsx'))
)
check(
  'sidebar no longer imports SidebarPlusPopover',
  !/SidebarPlusPopover/.test(sidebar)
)
check(
  'sidebar renders FilePlus and FolderPlus icon buttons',
  /<FilePlus\b/.test(sidebar) && /<FolderPlus\b/.test(sidebar)
)
check(
  'sidebar has "New page" and "New folder" button titles',
  /title="New page \(Ctrl\/Cmd-N\)"/.test(sidebar) &&
    /title="New folder"/.test(sidebar)
)
check(
  'sidebar Folders-header FolderPlus calls onCreateFolder, not grimoire create',
  /onClick=\{\(\) => onCreateFolder\(''\)\}/.test(sidebar)
)
check(
  'grimoire switcher header carries the "New grimoire" button',
  /title="New grimoire \(Ctrl\/Cmd-Shift-N\)"/.test(switcher)
)

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
  'grimoire settings sheet no longer shows a Root folder field',
  !/Root folder/.test(switcher) && !/selectDirectory/.test(switcher)
)

// --- Sidebar wiring ------------------------------------------------------

check('sidebar imports SidebarPageContextMenu', /SidebarPageContextMenu/.test(sidebar))
check('sidebar imports GrimoireSwitcherHandle', /GrimoireSwitcherHandle/.test(sidebar))
check('sidebar renders <SidebarPageContextMenu>', /<SidebarPageContextMenu\b/.test(sidebar))
check('sidebar passes ref to <GrimoireSwitcher ref={grimoireSwitcherRef}>', /ref=\{grimoireSwitcherRef\}/.test(sidebar))
check('sidebar has grimoireSwitcherRef handle', /grimoireSwitcherRef\s*=\s*useRef<GrimoireSwitcherHandle>/.test(sidebar))
check('sidebar right-click handler on document row', /onContextMenu/.test(sidebar))
check('sidebar tracks context menu state', /setContextMenu\(/.test(sidebar))
check('sidebar accepts onCreatePageDirect prop', /onCreatePageDirect\??: \(\) => void/.test(sidebar))
check('sidebar accepts onOpenInSidePeek prop', /onOpenInSidePeek\??: \(path: string\) => void/.test(sidebar))
check('sidebar accepts onOpenInNewWindow prop', /onOpenInNewWindow\??: \(path: string\) => void/.test(sidebar))
check('sidebar accepts onImportFile prop', /onImportFile: \(\) => void/.test(sidebar))
check('sidebar accepts onImportFolder prop', /onImportFolder: \(\) => void/.test(sidebar))
check(
  'sidebar subscribes to open-new-grimoire shortcut action',
  /onShortcutAction\(['"]open-new-grimoire['"]/.test(sidebar)
)
check(
  'sidebar New-page button calls onCreatePageDirect',
  /onClick=\{\(\) => onCreatePageDirect\?\.\(\)\}/.test(sidebar)
)
check(
  'sidebar Import file / Import folder buttons render above Passwords',
  /Import file/.test(sidebar) && /Import folder/.test(sidebar) &&
    /onImportFile/.test(sidebar) && /onImportFolder/.test(sidebar) &&
    /FileUp/.test(sidebar) && /FolderUp/.test(sidebar)
)

// --- workspace-app wiring ------------------------------------------------

check(
  'workspace-app wires onCreatePageDirect to createDocumentAt',
  /onCreatePageDirect=\{\(\) => void createDocumentAt\(/.test(workspaceApp)
)
check(
  'workspace-app wires onImportFile + onImportFolder',
  /onImportFile=\{|onImportFolder=\{|importPages|importFolder/.test(workspaceApp),
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
check(
  'workspace-app Mod-N fires createDocumentAt via ref',
  /createDocumentAtRef\.current\(/.test(workspaceApp)
)
check(
  'workspace-app Mod-Shift-N fires open-new-grimoire via shortcut bus',
  /fireShortcutAction\(['"]open-new-grimoire['"]/.test(workspaceApp)
)
check(
  'shortcut-bus exposes onShortcutAction and fireShortcutAction',
  /export function onShortcutAction/.test(shortcutBus) &&
    /export function fireShortcutAction/.test(shortcutBus)
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
