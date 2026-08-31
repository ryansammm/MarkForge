'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CloudUpload,
  FilePlus,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  KeyRound,
  LogOut,
  Pencil,
  Search,
  Settings,
  SquarePlus,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { FileTreeNode, MarkdownDocument } from '@/lib/file-store'
import { grimoireHeaders } from '@/lib/grimoire-client'
import { APP_SIGNATURE, APP_VERSION } from '@/lib/version'
import type { OpenIntent } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { openHandlers } from './tab-gestures'
import { ResizeHandle } from './resize-handle'
import { collectDroppedFiles } from './explorer-drop'
import { usePersistedList } from '@/lib/use-persisted'
import { onShortcutAction } from '@/lib/shortcut-bus'
import { GrimoireSwitcher, type GrimoireSwitcherHandle } from './grimoire-switcher'
import { SidebarPageContextMenu } from './sidebar-page-context-menu'

/**
 * Sidebar width, and the range it can be dragged through.
 *
 * The floor is where the row actions and a few characters of a name still fit; below
 * that the panel is a column of ellipses. The ceiling is a guess at the widest anyone
 * would want on a laptop, and it is what stops a width restored from a larger monitor
 * from eating the document — see `usePersistedSize`, which clamps on read.
 */
export const SIDEBAR_WIDTH = { default: 256, min: 180, max: 560 } as const

/** Present only inside the Electron shell — see electron/preload.cjs. */
interface DesktopBridge {
  desktop: boolean
  syncToCloud: () => Promise<{ ok: boolean; copied?: number; skipped?: number; error?: string }>
  /**
   * Save a text file via the OS "Save As…" dialog. Returns the
   * absolute path the user picked, or `null` if they cancelled.
   * Throws if the underlying write fails.
   */
  saveFile: (payload: { content: string; defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
}

declare global {
  interface Window {
    markforge?: DesktopBridge
  }
}

interface SidebarProps {
  tree: FileTreeNode[]
  activePath: string | null
  onSelectFile: (path: string, intent: OpenIntent) => void
  onOpenSearch: () => void
  /** `parentDir` is '' for the workspace root. */
  onCreateDocument: (parentDir: string) => void
  onCreateFolder: (parentDir: string) => void
  onRenameNode: (node: FileTreeNode) => void
  onDeleteNode: (node: FileTreeNode) => void
  /** Move a document into a folder (drag & drop). `to` already includes the filename. */
  onMoveDocument?: (from: string, to: string) => Promise<void>
  onOpenTrash: () => void
  onOpenPasswords: () => void
  onOpenSettings: () => void
  onSignOut: () => void
  /** Refetch the index after a native import copied files into the store. */
  onAfterImport?: () => Promise<void>
  /** Pick a single .md/.markdown/.txt file from disk. */
  onImportFile: () => void
  /** Pick a folder and import its .md/.markdown/.txt tree. */
  onImportFolder: () => void
  /** Current index documents, for pin titles. */
  documents?: Record<string, MarkdownDocument>
  /** Drawer state. Only meaningful below the md breakpoint. */
  open: boolean
  onClose: () => void
  /** Width in pixels, applied from md up. Below that this is a fixed-width drawer. */
  width: number
  onWidthChange: (width: number) => void
  /** Grimoire state */
  activeGrimoireId: string | null
  onSelectGrimoire: (id: string) => void
  onGrimoireCreated?: (grimoire: { id: string; name: string }) => void
  /** Backend kind from /api/health — drives the "Sync to cloud" visibility. */
  storageKind: string | null
  /** Direct create (no name dialog) for the top-level `+` popover. */
  onCreatePageDirect?: () => void
  /** Open a page in the side peek overlay. */
  onOpenInSidePeek?: (path: string) => void
  /** Open a page in a new window (Electron IPC; web fallback: new tab). */
  onOpenInNewWindow?: (path: string) => void
}

/**
 * Row actions appear on hover and on keyboard focus.
 *
 * `focus-within` matters more than it looks: without it these controls exist only
 * for people using a mouse.
 */
const ACTION_GROUP =
  'ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'

const ACTION_BUTTON =
  'flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

/** The desktop bridge never changes during a session; there is nothing to subscribe to. */
const subscribeNever = () => () => {}

/**
 * One indentation rule for the whole tree, and it lives in two places only.
 *
 * A row is a twisty, an icon and a name. Folders have a twisty; documents do not, so
 * a document row reserves the same width for one it will never draw — otherwise a
 * document's icon sits under its parent folder's *chevron* instead of under the
 * folder's icon, and no two names in the panel share a left edge.
 *
 * The icon box is fixed rather than the icons being the same size, because a folder
 * reads better slightly larger than a document. Sizing the box instead of the glyph
 * is what lets both be true.
 */
const ROW =
  'group flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors'
const ROW_BUTTON = 'flex min-w-0 flex-1 items-center gap-1.5 text-left'
const ICON_BOX = 'flex size-4 shrink-0 items-center justify-center'
/** The width a document row gives back to the chevron it has no use for. */
const TWISTY_BOX = 'flex size-3.5 shrink-0 items-center justify-center'

export function Sidebar({
  tree,
  activePath,
  onSelectFile,
  onOpenSearch,
  onCreateDocument,
  onCreateFolder,
  onRenameNode,
  onDeleteNode,
  onMoveDocument,
  onOpenTrash,
  onOpenPasswords,
  onOpenSettings,
  onSignOut,
  onAfterImport,
  onImportFile,
  onImportFolder,
  documents,
  open,
  onClose,
  width,
  onWidthChange,
  activeGrimoireId,
  onSelectGrimoire,
  onGrimoireCreated,
  storageKind,
  onCreatePageDirect,
  onOpenInSidePeek,
  onOpenInNewWindow,
}: SidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({})
  // Depth counter, not a boolean: enter/leave fire for every child element, and a
  // boolean flickers the highlight off while crossing gaps between rows.
  const [dragDepth, setDragDepth] = useState(0)
  // In-tree drag: the document row being dragged (ref, so dragstart needs no rerender)
  // and the folder row currently highlighted as the drop target.
  const dragSource = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // True while an in-tree drag hovers the empty tree area, where a drop moves
  // the document back to the workspace root.
  const [droppingRoot, setDroppingRoot] = useState(false)
  // Pinned documents, remembered per device in localStorage.
  const [pinnedPaths, togglePinned] = usePersistedList('markforge.pinned-docs')
  // The Electron bridge exists only in the desktop shell. useSyncExternalStore
  // reads it after mount without an effect: server snapshot false keeps the
  // first client render identical to the HTML.
  const isDesktop = useSyncExternalStore(
    subscribeNever,
    () => Boolean(window.markforge),
    () => false
  )
  // Imperative handle to the grimoire switcher — the `+` button next to the
  // grimoire name calls `requestCreate` to open the inline name input
  // directly, without first opening the dropdown.
  const grimoireSwitcherRef = useRef<GrimoireSwitcherHandle>(null)
  /*
    Cmd/Ctrl-Shift-N fires from the workspace's global keydown handler; this
    subscription catches it and routes to the same `requestCreate` the
    sidebar's "New grimoire" button uses.
  */
  useEffect(() => {
    return onShortcutAction('open-new-grimoire', () => {
      grimoireSwitcherRef.current?.requestCreate()
    })
  }, [])
  // Right-click on a folder-tree page. `null` means the menu is closed.
  const [contextMenu, setContextMenu] = useState<{ path: string; x: number; y: number } | null>(null)

  /** Explicit push of the local corpus to R2 - the only road to the cloud. */
  const runCloudSync = async () => {
    try {
      toast.info('Syncing to cloud…')
      const res = await window.markforge!.syncToCloud()
      if (!res.ok) throw new Error(res.error ?? 'sync failed')
      toast.success(
        `Cloud updated — ${res.copied} uploaded, ${res.skipped} already in sync`
      )
    } catch (err) {
      toast.error(`Cloud sync failed: ${(err as Error).message}`)
    }
  }

  /** Explorer drop: one bulk request, index rebuilt server-side once. */
  const handleDrop = async (dataTransfer: DataTransfer) => {    try {
      const files = await collectDroppedFiles(dataTransfer)
      if (files.length === 0) return
      toast.info(`Importing ${files.length} file(s)…`)
      const payload = await Promise.all(
        files.map(async ({ path, file }) => ({ path, content: await file.text() }))
      )
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...grimoireHeaders() },
        body: JSON.stringify({ files: payload }),
      })
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(detail?.error ?? `import failed (${response.status})`)
      }
      const result = (await response.json()) as { copied: number; skipped: number }
      await onAfterImport?.()
      if (result.skipped > 0)
        toast.warning(
          `Dropped in: ${result.copied} imported, ${result.skipped} skipped (already exist)`
        )
      else toast.success(`Dropped in: ${result.copied} imported`)
    } catch (err) {
      toast.error(`Drop import failed: ${(err as Error).message}`)
    }
  }

  /**
   * True when the dragged payload is files from outside the app (OS, another page).
   * In-tree moves carry only `text/plain`; distinguishing keeps the "drop to import"
   * overlay and the import handler off internal drags.
   */
  const isForeignFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes('Files')

  /** In-tree drop of a document row onto a folder row → move it there. */
  const handleDocDrop = async (targetPath: string) => {
    const from = dragSource.current
    setDropTarget(null)
    setDroppingRoot(false)
    dragSource.current = null
    if (!from) return
    const name = from.split('/').pop() ?? from
    const to = targetPath ? `${targetPath}/${name}` : name
    if (to === from) return
    await onMoveDocument?.(from, to)
  }

  // Escape closes the drawer, which is the one affordance a phone user cannot
  // discover but a keyboard user expects.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [path]: !prev[path],
    }))
  }

  /**
   * Arrow-key movement through the tree.
   *
   * Tab alone reached every row, but stepping through a hundred documents one Tab at
   * a time is not navigation. Up and Down move between rows; Right opens a folder and
   * Left closes it, which is what a tree is expected to do.
   *
   * Driven off the rendered DOM rather than a parallel model of the tree: the rows
   * are already in document order, so the order the eye sees and the order the keys
   * follow cannot drift apart.
   */
  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return

    const container = event.currentTarget
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-tree-row]'))
    if (rows.length === 0) return

    const active = document.activeElement as HTMLElement | null
    const current = rows.findIndex((row) => row === active || row.contains(active))

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const row = rows[current]
      const folderPath = row?.dataset.folderPath
      if (!folderPath) return
      const expanded = row.dataset.expanded === 'true'
      // Right on an open folder, or Left on a closed one, falls through to movement.
      if ((event.key === 'ArrowRight') === expanded) {
        event.preventDefault()
        const next = rows[event.key === 'ArrowRight' ? current + 1 : current - 1]
        next?.focus()
        return
      }
      event.preventDefault()
      toggleFolder(folderPath)
      return
    }

    event.preventDefault()
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)))

    rows[target]?.focus()
  }

  /*
    Depth is not a parameter any more. Indentation comes entirely from the nesting of
    the wrappers below, so a row cannot be indented twice — which is what used to
    happen to a nested folder: once by its parent's wrapper and again by an `ml-3` on
    the row itself.
  */
  const renderTree = (nodes: FileTreeNode[]) => {
    return nodes.map((node) => {
      const isExpanded = expandedFolders[node.path] === true // Default collapsed

      if (node.isDir) {
        const isDropTarget = dropTarget === node.path
        return (
          <div
            key={node.path}
            className={cn('flex flex-col gap-0.5 rounded-md', isDropTarget && 'bg-sidebar-accent/60')}
          >
            <div
              className={cn(
                ROW,
                'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                isDropTarget && 'ring-1 ring-inset ring-primary'
              )}
              onDragOver={(event) => {
                if (!dragSource.current) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTarget(node.path)
              }}
onDragEnter={() => {
  if (!dragSource.current) return
  setDropTarget(node.path)
}}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return
                if (dropTarget === node.path) setDropTarget(null)
              }}
              onDrop={(event) => {
                if (!dragSource.current) return
                event.preventDefault()
                event.stopPropagation()
                void handleDocDrop(node.path)
              }}
            >
              <button
                type="button"
                onClick={() => toggleFolder(node.path)}
                className={ROW_BUTTON}
                aria-expanded={isExpanded}
                data-tree-row
                data-folder-path={node.path}
                data-expanded={isExpanded}
                // Every name in this tree truncates, and the sidebar is resizable
                // precisely because they do. The tooltip is the answer for the name
                // that is still too long at any width worth giving it.
                title={node.name}
              >
                <span className={TWISTY_BOX} aria-hidden="true">
                  {isExpanded ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </span>
                <span className={cn(ICON_BOX, 'text-(--icon-neutral)')}>
                  {isExpanded ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
                </span>
                <span className="truncate">{node.name}</span>
              </button>

              <span className={ACTION_GROUP}>
                <button
                  type="button"
                  className={ACTION_BUTTON}
                  title={`New document in ${node.name}`}
                  aria-label={`New document in ${node.name}`}
                  onClick={() => onCreateDocument(node.path)}
                >
                  <FilePlus className="size-3.5" />
                </button>
                <button
                  type="button"
                  className={ACTION_BUTTON}
                  title={`New folder in ${node.name}`}
                  aria-label={`New folder in ${node.name}`}
                  onClick={() => onCreateFolder(node.path)}
                >
                  <FolderPlus className="size-3.5" />
                </button>
                <button
                  type="button"
                  className={ACTION_BUTTON}
                  title={`Rename ${node.name}`}
                  aria-label={`Rename ${node.name}`}
                  onClick={() => onRenameNode(node)}
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  className={cn(ACTION_BUTTON, pinnedPaths.includes(node.path) && 'text-primary')}
                  title={pinnedPaths.includes(node.path) ? `Unpin ${node.name}` : `Pin ${node.name}`}
                  aria-label={
                    pinnedPaths.includes(node.path) ? `Unpin ${node.name}` : `Pin ${node.name}`
                  }
                  onClick={() => togglePinned(node.path)}
                >
                  <Star className={cn('size-3', pinnedPaths.includes(node.path) && 'fill-current')} />
                </button>
                <button
                  type="button"
                  className={cn(ACTION_BUTTON, 'hover:text-destructive')}
                  title={`Delete ${node.name}`}
                  aria-label={`Delete ${node.name}`}
                  onClick={() => onDeleteNode(node)}
                >
                  <Trash2 className="size-3" />
                </button>
              </span>
            </div>

            {isExpanded && node.children && node.children.length > 0 && (
              <div className="ml-3 flex flex-col gap-0.5 border-l border-sidebar-border/40 pl-1.5">
                {renderTree(node.children)}
              </div>
            )}
          </div>
        )
      }

      const isActive = activePath === node.path
      return (
        <div
          key={node.path}
          draggable
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({ path: node.path, x: event.clientX, y: event.clientY })
          }}
          onDragStart={(event) => {
            dragSource.current = node.path
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', node.path)
          }}
          onDragEnd={() => {
            dragSource.current = null
            setDropTarget(null)
          }}
          className={cn(
            ROW,
            'cursor-grab active:cursor-grabbing',
            isActive
              ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-xs'
              : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
          )}
        >
          <button
            type="button"
            {...openHandlers((intent) => onSelectFile(node.path, intent))}
            className={ROW_BUTTON}
            data-tree-row
            /*
              The title first, because the title is the thing that got truncated —
              these rows show a document's title, not its filename, and a long one is
              unrecoverable from the few words that survive the ellipsis. The path
              goes underneath: it is the other question a truncated row raises, and
              two documents can share a title.
            */
            title={`${node.name}\n${node.path}`}
            {...(isActive ? { 'aria-current': 'page' as const } : {})}
          >
            {/* Empty on purpose: it holds the column a folder's chevron occupies. */}
            <span className={TWISTY_BOX} aria-hidden="true" />
            <span className={ICON_BOX}>
              <FileText
                className={cn('size-3.5', isActive ? 'text-primary' : 'text-muted-foreground')}
              />
            </span>
            <span className="truncate">{node.name}</span>
          </button>

          <span className={ACTION_GROUP}>
            {/*
              The discoverable way to reach a second tab. Mod-click and middle-click
              do the same thing, but neither announces itself — and the tab strip,
              which does, only appears once a second tab already exists.
            */}
            <button
              type="button"
              className={ACTION_BUTTON}
              title={`Open ${node.name} in a new tab`}
              aria-label={`Open ${node.name} in a new tab`}
              onClick={() => onSelectFile(node.path, { newTab: true, background: false })}
            >
              <SquarePlus className="size-3" />
            </button>
            <button
              type="button"
              className={ACTION_BUTTON}
              title={`Rename ${node.name}`}
              aria-label={`Rename ${node.name}`}
              onClick={() => onRenameNode(node)}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              className={cn(ACTION_BUTTON, 'hover:text-destructive')}
              title={`Delete ${node.name}`}
              aria-label={`Delete ${node.name}`}
              onClick={() => onDeleteNode(node)}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        </div>
      )
    })
  }

  return (
    <>
      {/*
        Backdrop, below md only. Without it a tap outside the drawer does nothing,
        which on a phone reads as the app having frozen.
      */}
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      )}

      <aside
        /*
          The width is a custom property applied only from md up, rather than an
          inline `width`. Below md this is a drawer over the document, where the
          useful width is a fraction of the viewport and has nothing to do with the
          number someone dragged to on a desktop.
        */
        style={{ '--sidebar-width': `${width}px` } as React.CSSProperties}
        className={cn(
          'relative flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:w-[var(--sidebar-width)]',
          // Below md the sidebar is a drawer: it used to take 256 of 375 pixels and
          // leave 119 for the document, which is not a mobile layout.
          'fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:static md:z-auto md:translate-x-0',
          open ? 'translate-x-0 shadow-xl' : '-translate-x-full',
          dragDepth > 0 && 'ring-2 ring-inset ring-primary'
        )}
onDragEnter={(event) => {
  if (!isForeignFiles(event)) return
  event.preventDefault()
  setDragDepth((depth) => depth + 1)
}}
onDragOver={(event) => {
  if (isForeignFiles(event)) event.preventDefault()
}}
onDragLeave={(event) => {
  if (!isForeignFiles(event)) return
  setDragDepth((depth) => Math.max(0, depth - 1))
}}
onDrop={(event) => {
  if (!isForeignFiles(event)) return
  event.preventDefault()
  setDragDepth(0)
  void handleDrop(event.dataTransfer)
}}
      >
        {dragDepth > 0 && (
          <div className="pointer-events-none absolute inset-x-3 top-16 z-10 rounded-md border border-dashed border-primary bg-background/90 px-3 py-2 text-center text-xs font-medium text-primary">
            Drop .md files or folders to import
          </div>
        )}
      <ResizeHandle
        width={width}
        min={SIDEBAR_WIDTH.min}
        max={SIDEBAR_WIDTH.max}
        onResize={onWidthChange}
        edge="right"
        label="the sidebar"
        defaultWidth={SIDEBAR_WIDTH.default}
      />
      <header className="flex h-14 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2 px-1">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            M
          </span>
          <span className="truncate text-sm font-semibold tracking-tight">MarkForge</span>
        </div>
      </header>

      <GrimoireSwitcher
        ref={grimoireSwitcherRef}
        activeGrimoireId={activeGrimoireId}
        onSelect={onSelectGrimoire}
        onCreated={onGrimoireCreated ?? (() => {})}
      />

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex h-8 w-full items-center gap-2 rounded-md border bg-background/60 px-2.5 text-xs text-muted-foreground shadow-xs transition-colors hover:border-primary/40 hover:bg-background hover:text-foreground"
        >
          <Search className="size-3.5" />
          <span>Search documents</span>
          <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl K</kbd>
        </button>
      </div>

      {pinnedPaths.length > 0 && (
        <div className="mb-1 px-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Star className="size-3 fill-(--accent-fill) text-(--accent-fill)" />
            <span>Pinned</span>
          </div>
          {pinnedPaths
            .filter((p) => documents?.[p])
            .map((path) => {
              const doc = documents![path]
              return (
                <div key={path} className="group flex items-center rounded-md hover:bg-sidebar-accent/60">
                  <button
                    type="button"
                    {...openHandlers((intent) => onSelectFile(path, intent))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left text-xs text-foreground"
                    title={doc.title || path}
                  >
                    <Star className="size-3 shrink-0 fill-(--accent-fill) text-(--accent-fill)" />
                    <span className="truncate">{doc.title || path}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => togglePinned(path)}
                    title="Unpin"
                    aria-label={`Unpin ${doc.title || path}`}
                    className={cn(ACTION_BUTTON, 'mr-1')}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
        </div>
      )}
      <nav
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4',
          droppingRoot && 'ring-2 ring-inset ring-primary/60 rounded-lg'
        )}
        aria-label="Workspace documents"
        onKeyDown={onTreeKeyDown}
        /*
          Dropping a document onto the empty tree area moves it back to the root.
          Folder rows stopPropagation on their own drop; a drop anywhere else in the
          tree that reaches here is a move-to-root intent.
        */
        onDragOver={(event) => {
          if (!dragSource.current) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDragEnter={(event) => {
          if (!dragSource.current) return
          if (event.currentTarget !== event.target) return
          setDroppingRoot(true)
        }}
        onDragLeave={(event) => {
          if (!dragSource.current) return
          if (event.currentTarget.contains(event.relatedTarget as Node)) return
          setDroppingRoot(false)
        }}
        onDrop={(event) => {
          if (!dragSource.current) return
          event.preventDefault()
          setDroppingRoot(false)
          void handleDocDrop('')
        }}
      >
        <div className="mb-2 mt-1 flex items-center justify-between gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>Folders</span>
          {/*
            Two affordances: `New page` writes to the active grimoire and
            opens it as a tab; `New folder` creates a folder under the
            active grimoire. The `New grimoire` button lives next to the
            grimoire switcher name instead — folders are not grimoires, and
            putting the grimoire creator in the grimoire section lets the
            shortcut hint and the dropdown picklist share a single button.
          */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => onCreatePageDirect?.()}
              title="New page (Ctrl/Cmd-N)"
              aria-label="New page"
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            >
              <FilePlus className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onCreateFolder('')}
              title="New folder"
              aria-label="New folder"
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            >
              <FolderPlus className="size-3.5" />
            </button>
          </div>
        </div>

        {tree.length > 0 ? (
          renderTree(tree)
        ) : (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            No documents yet. Use the + above to create one.
          </div>
        )}
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        {isDesktop && storageKind === 'cloud' && (
          <button
            type="button"
            onClick={() => void runCloudSync()}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <CloudUpload className="size-3.5 shrink-0" />
            <span>Sync to cloud…</span>
          </button>
        )}
        {/*
          Import file / Import folder: pull text files from disk into the
          active grimoire. The page menu already has an Import file action
          for the active page — this is the same surface, surfaced in the
          sidebar so it is reachable when no page is open.
        */}
        <button
          type="button"
          onClick={onImportFile}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <FileUp className="size-3.5 shrink-0" />
          <span>Import file</span>
        </button>
        <button
          type="button"
          onClick={onImportFolder}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <FolderUp className="size-3.5 shrink-0" />
          <span>Import folder</span>
        </button>
        {/*
          Beside Trash rather than in the document tree: the vault is not a document,
          is not indexed, and is not part of the corpus. Putting it in the tree would
          suggest otherwise to every reader of this file and every user of the app.
        */}
        <button
          type="button"
          onClick={onOpenPasswords}
          title="Open the password vault (Ctrl+P)"
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <KeyRound className="size-3.5 shrink-0" />
          <span>Passwords</span>
          {/*
            Advertised the way search advertises —K. A shortcut nobody can discover
            is a shortcut nobody uses, and this one overrides Print — so it had
            better be visibly deliberate rather than a surprise.
          */}
          <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl P</kbd>
        </button>
        <button
          type="button"
          onClick={onOpenTrash}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <Trash2 className="size-3.5 shrink-0" />
          <span>Trash</span>
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <Settings className="size-3.5 shrink-0" />
          <span>Settings</span>
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <LogOut className="size-3.5 shrink-0" />
          <span>Sign out</span>
        </button>
        <div
          className="flex items-center justify-between px-2 pt-1 text-[10px] tracking-wide text-(--text-disabled)"
          title="MarkForge"
        >
          <span>
            MarkForge v{APP_VERSION}
          </span>
          <span>© {APP_SIGNATURE}</span>
        </div>
      </div>
      <SidebarPageContextMenu
        path={contextMenu?.path ?? ''}
        position={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null}
        isDesktop={isDesktop}
        onOpenInSidePeek={(path) => onOpenInSidePeek?.(path)}
        onOpenInNewWindow={(path) => onOpenInNewWindow?.(path)}
        onDismiss={() => setContextMenu(null)}
      />
      </aside>
    </>
  )
}
