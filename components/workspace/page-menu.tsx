'use client'

import * as React from 'react'
import { ChevronRight, Copy, Files, FolderInput, Lock, MoreVertical, Trash2, Type, Maximize2, Upload, Download } from 'lucide-react'
import { Menu } from '@base-ui/react/menu'
import { Popover } from '@base-ui/react/popover'
import { toast } from 'sonner'
import type { FileTreeNode, MarkdownDocument } from '@/lib/file-store'
import { frontmatterView, frontmatterWidth } from '@/lib/markdown/frontmatter'
import { cn } from '@/lib/utils'
import { copyToClipboard } from '@/lib/clipboard'

/**
 * The `⋯` button rendered top-right of the document viewer.
 *
 * Owns the small set of page-level actions Notion has on every page:
 *  - Copy page content  (decrypted body to clipboard)
 *  - Duplicate          (creates a copy in the same folder, opens a new tab)
 *  - Move to            (folder picker scoped to the active grimoire)
 *  - Move to trash      (same flow as the sidebar Delete)
 *  - Small text / Full width (writes `view` / `width` to frontmatter)
 *  - Lock page / Import / Export (stubs — wired in Tasks 9 and 10)
 *
 * No state of its own about whether the document is dirty or what its
 * `view` field is — the parent passes both via props so this component
 * stays a leaf that is easy to test and to disable.
 */

export interface PageMenuProps {
  document: MarkdownDocument
  body: string | null
  /** Folder tree of the active grimoire. Used by the Move to picker. */
  tree: FileTreeNode[]
  /** When true, the menu hides (during load / error / no document). */
  disabled?: boolean
  onCopy: () => void
  onDuplicate: () => void
  onMoveTo: (destDir: string) => void
  onTrash: () => void
  onSetView: (view: 'small' | 'full') => void
  onSetWidth: (width: 'full' | 'default') => void
  /**
   * `true` when the document is locked. The Lock/Unlock label flips
   * accordingly; the caller decides what to do when the user
   * clicks. `onUnlock` takes no argument; `onLock` receives the
   * passphrase the user typed into a native `window.prompt()` so
   * the menu stays a single dropdown.
   */
  isLocked: boolean
  onLock?: (passphrase: string) => void
  onUnlock?: () => void
  onImport?: () => void
  onExport?: () => void
}

export function PageMenu({
  document,
  body,
  tree,
  disabled,
  onCopy,
  onDuplicate,
  onMoveTo,
  onTrash,
  onSetView,
  onSetWidth,
  isLocked,
  onLock,
  onUnlock,
  onImport,
  onExport,
}: PageMenuProps) {
  const view = frontmatterView(document.frontmatter)
  const width = frontmatterWidth(document.frontmatter)
  const [moveOpen, setMoveOpen] = React.useState(false)

  return (
    <div className="absolute right-4 top-4 z-10 flex items-center gap-1">
      <Popover.Root open={moveOpen} onOpenChange={setMoveOpen}>
        <Popover.Trigger
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent',
            'data-[popup-open]:bg-accent data-[popup-open]:text-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
          aria-label="Page actions"
          title="Page actions"
          onClick={() => {
            // Avoid double-open: a Base UI Menu trigger and Popover trigger
            // do not compose on the same element. The popover *is* the menu.
            // The dedicated menu below uses its own trigger.
          }}
        >
          <MoreVertical className="size-4" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Popover.Popup className="min-w-[220px] rounded-md border bg-popover p-1 text-sm shadow-md outline-none">
              <MenuSection>
                <Item
                  icon={<Copy className="size-3.5" aria-hidden />}
                  label="Copy page content"
                  onClick={() => {
                    if (body === null) {
                      toast.error('Body still loading')
                      return
                    }
                    void copyToClipboard(body).then((ok) => {
                      if (ok) toast.success('Page content copied')
                      else toast.error('Could not access the clipboard')
                      onCopy()
                    })
                  }}
                />
                <Item
                  icon={<Files className="size-3.5" aria-hidden />}
                  label="Duplicate"
                  onClick={onDuplicate}
                />
                <FolderPicker
                  tree={tree}
                  currentPath={document.path}
                  onPick={(destDir) => {
                    setMoveOpen(false)
                    onMoveTo(destDir)
                  }}
                />
                <Item
                  icon={<Trash2 className="size-3.5" aria-hidden />}
                  label="Move to trash"
                  destructive
                  onClick={onTrash}
                />
              </MenuSection>

              <MenuSeparator />

              <MenuSection>
                <Item
                  icon={<Type className="size-3.5" aria-hidden />}
                  label="Small text"
                  trailing={view === 'small' ? '✓' : undefined}
                  onClick={() => onSetView('small')}
                />
                <Item
                  icon={<Type className="size-3.5" aria-hidden />}
                  label="Full text"
                  trailing={view === 'full' ? '✓' : undefined}
                  onClick={() => onSetView('full')}
                />
                <Item
                  icon={<Maximize2 className="size-3.5" aria-hidden />}
                  label="Full width"
                  trailing={width === 'full' ? '✓' : undefined}
                  onClick={() => onSetWidth('full')}
                />
                <Item
                  icon={<Maximize2 className="size-3.5" aria-hidden />}
                  label="Default width"
                  trailing={width === 'default' ? '✓' : undefined}
                  onClick={() => onSetWidth('default')}
                />
              </MenuSection>

              <MenuSeparator />

              <MenuSection>
                {isLocked ? (
                  <Item
                    icon={<Lock className="size-3.5" aria-hidden />}
                    label="Unlock page"
                    onClick={() => {
                      onUnlock?.()
                    }}
                  />
                ) : (
                  <Item
                    icon={<Lock className="size-3.5" aria-hidden />}
                    label="Lock page"
                    onClick={() => {
                      // The popover stays a single dropdown; the passphrase
                      // comes from a native prompt. A bespoke modal would
                      // be nicer — Task 9 keeps it boring on purpose.
                      const passphrase = window.prompt('Passphrase to lock this page with:')
                      if (passphrase === null) return
                      if (!passphrase) {
                        toast.error('Passphrase must not be empty.')
                        return
                      }
                      onLock?.(passphrase)
                    }}
                  />
                )}
                <Item
                  icon={<Upload className="size-3.5" aria-hidden />}
                  label="Import"
                  hint="Task 10"
                  onClick={() => {
                    toast.message('Import is coming in Task 10')
                    onImport?.()
                  }}
                />
                <Item
                  icon={<Download className="size-3.5" aria-hidden />}
                  label="Export"
                  hint="Task 10"
                  onClick={() => {
                    toast.message('Export is coming in Task 10')
                    onExport?.()
                  }}
                />
              </MenuSection>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {disabled ? <span className="sr-only">Page actions unavailable</span> : null}
    </div>
  )
}

function Item({
  icon,
  label,
  onClick,
  destructive,
  trailing,
  hint,
}: {
  icon?: React.ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
  trailing?: string
  hint?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-default items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:bg-accent focus-visible:text-accent-foreground',
        destructive && 'text-destructive hover:bg-destructive/10 hover:text-destructive'
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {trailing ? <span className="text-xs text-muted-foreground">{trailing}</span> : null}
      {hint ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{hint}</span> : null}
    </button>
  )
}

function MenuSection({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col">{children}</div>
}

function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />
}

/**
 * The "Move to" item hosts a nested submenu. Clicking it opens a list of
 * every folder in the active grimoire, plus the workspace root. Filtering
 * the current document's own folder is the caller's job; here we just
 * present the candidates flat.
 */
function FolderPicker({
  tree,
  currentPath,
  onPick,
}: {
  tree: FileTreeNode[]
  currentPath: string
  onPick: (destDir: string) => void
}) {
  const folders = collectFolders(tree, '', currentPath)
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'flex w-full cursor-default items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none',
          'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
          'data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground'
        )}
      >
        <FolderInput className="size-3.5" aria-hidden />
        <span className="flex-1 truncate">Move to</span>
        <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="right" sideOffset={2} align="start" className="z-50">
          <Menu.Popup className="max-h-[320px] min-w-[220px] overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md outline-none">
            {folders.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No folders</div>
            ) : (
              folders.map((f) => (
                <button
                  key={f.path || '<root>'}
                  type="button"
                  onClick={() => onPick(f.path)}
                  className="flex w-full cursor-default items-center gap-2 truncate rounded px-2 py-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground"
                >
                  <FolderInput className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{f.label}</span>
                </button>
              ))
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function collectFolders(
  nodes: FileTreeNode[],
  prefix: string,
  currentPath: string
): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = []
  for (const node of nodes) {
    if (!node.isDir) continue
    const fullPath = prefix ? `${prefix}/${node.name}` : node.name
    // Don't show the document's own folder as a destination — moving a
    // file into itself is a no-op, and a folder containing the file
    // would not change its parent either.
    if (currentPath.startsWith(`${fullPath}/`)) continue
    out.push({ path: fullPath, label: fullPath || 'Workspace root' })
    if (node.children) out.push(...collectFolders(node.children, fullPath, currentPath))
  }
  return out
}
