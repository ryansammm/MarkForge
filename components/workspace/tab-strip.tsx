'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { MarkdownDocument } from '@/lib/file-store'
import { tabPath, type Tab } from '@/lib/tabs'
import { cn } from '@/lib/utils'

interface TabStripProps {
  /** Tabs. */
  tabs: Tab[]
  /**
   * When `true`, drops the strip's own border and matches the parent's
   * background. Used when the strip is inlined into the workspace header
   * rather than sitting in its own row.
   */
  flush?: boolean
  activeId: string | null
  /** The index, for titles. */
  documents: Record<string, MarkdownDocument>
  /** Documents whose last save was refused and not yet resolved. */
  conflicted: ReadonlySet<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseToRight: (id: string) => void
  onReorder: (from: number, to: number) => void
  onNew: () => void
}

/**
 * The document's title, falling back to its filename.
 *
 * The fallback is not decoration: a document created a moment ago is in a tab before
 * the index patch that carries its title has landed, and a tab labelled `undefined`
 * would be the first thing anyone saw after making one.
 */
export function documentLabel(path: string, documents: Record<string, MarkdownDocument>): string {
  const title = documents[path]?.title
  if (title) return title
  return path.split('/').pop()?.replace(/\.md$/i, '') || path
}

/** Which tab the context menu belongs to, and where to draw it. */
interface MenuState {
  id: string
  index: number
  x: number
  y: number
}

/**
 * The open documents.
 *
 * Rendered only when there is more than one — a single-document session should not
 * pay 36 pixels of height to be told it has one document open. Which is also why the
 * `+` here is not the only way to reach a second tab: Mod-click, middle-click and the
 * sidebar's own "open in new tab" action all get there while this is still hidden.
 */
export function TabStrip({
  tabs,
  activeId,
  documents,
  conflicted,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReorder,
  onNew,
  flush,
}: TabStripProps) {
  const listRef = useRef<HTMLUListElement>(null)
  const activeRef = useRef<HTMLLIElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  /**
   * The tab being dragged, in two places on purpose.
   *
   * The ref is what the drop reads. State would be a render behind: `dragstart` and
   * `drop` are separate events, and nothing guarantees React has re-rendered between
   * them — with a fast drag, or with events dispatched back to back, the drop would
   * see `null` and quietly do nothing. The state exists only to dim the tab.
   */
  const draggingRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)

  const endDrag = () => {
    draggingRef.current = null
    setDragging(null)
  }

  /**
   * Keeps the focused tab on screen.
   *
   * Scrolls the strip itself rather than calling `scrollIntoView`, which would also be
   * free to scroll the page — and the document below is what the reader is looking at.
   * Matters most for Alt+9 and for a phone, where the strip is mostly off-screen.
   */
  useEffect(() => {
    const list = listRef.current
    const tab = activeRef.current
    if (!list || !tab) return

    const left = tab.offsetLeft
    const right = left + tab.offsetWidth
    if (left < list.scrollLeft) list.scrollLeft = left
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth
  }, [activeId, tabs.length])

  // Escape and any click elsewhere dismiss the menu, which is the least a menu has to
  // do to not be a trap.
  useEffect(() => {
    if (!menu) return
    const dismiss = () => setMenu(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [menu])

  const runAndClose = (action: () => void) => {
    setMenu(null)
    action()
  }

  return (
    <div
      className={cn(
        'relative flex h-9 shrink-0 items-stretch',
        flush ? 'bg-transparent' : 'border-b bg-sidebar/40'
      )}
    >
      <ul ref={listRef} className="flex min-w-0 flex-1 items-stretch overflow-x-auto" aria-label="Open documents">
        {tabs.map((tab, index) => {
          const path = tabPath(tab)
          const name = documentLabel(path, documents)
          const isActive = tab.id === activeId
          const hasConflict = conflicted.has(path)

          return (
            <li
              key={tab.id}
              ref={isActive ? activeRef : undefined}
              draggable
              onDragStart={(event) => {
                draggingRef.current = index
                setDragging(index)
                event.dataTransfer.effectAllowed = 'move'
                // Firefox refuses to start a drag without payload on the transfer.
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragOver={(event) => {
                if (draggingRef.current === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = draggingRef.current
                if (from !== null && from !== index) onReorder(from, index)
                endDrag()
              }}
              onDragEnd={endDrag}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ id: tab.id, index, x: event.clientX, y: event.clientY })
              }}
              className={cn(
                'group flex w-32 shrink-0 items-center border-r pl-3 pr-1 text-xs transition-colors md:w-40',
                isActive
                  ? 'bg-background font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-background/50 hover:text-foreground',
                dragging === index && 'opacity-40'
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                // Middle-click closes, as it does on a browser tab.
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  onClose(tab.id)
                }}
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault()
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
                title={
                  hasConflict
                    ? `${path} — a save was refused here and has not been resolved`
                    : path
                }
                {...(isActive ? { 'aria-current': 'page' as const } : {})}
              >
                {/*
                  A save this tab refused, still unresolved. It is the only thing in
                  the strip that reports something the reader cannot otherwise see:
                  the conflict may have been raised while they were on another tab,
                  and the save indicator only ever describes the document on screen.
                */}
                {hasConflict && (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-destructive"
                  />
                )}
                <span className="truncate">
                  {name}
                  {hasConflict && <span className="sr-only"> — unresolved save conflict</span>}
                </span>
              </button>

              {/*
                Revealed on hover and on keyboard focus. Always-visible close buttons
                on every tab turn the strip into a row of targets you can hit by
                accident while aiming for the tab itself.
              */}
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                title={`Close ${name}`}
                aria-label={`Close ${name}`}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={onNew}
        title="Open a document in a new tab"
        aria-label="Open a document in a new tab"
        className="flex size-9 shrink-0 items-center justify-center border-l text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>

      {menu && (
        <div
          role="menu"
          // Positioned at the pointer, so it is fixed rather than laid out in the strip.
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          className="fixed z-50 min-w-44 overflow-hidden rounded-md border bg-popover py-1 text-xs shadow-lg"
        >
          {[
            { label: 'Close', action: () => onClose(menu.id), enabled: true },
            {
              label: 'Close others',
              action: () => onCloseOthers(menu.id),
              enabled: tabs.length > 1,
            },
            {
              label: 'Close to the right',
              action: () => onCloseToRight(menu.id),
              enabled: menu.index < tabs.length - 1,
            },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={!item.enabled}
              onClick={() => runAndClose(item.action)}
              className="flex w-full items-center px-3 py-1.5 text-left text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
