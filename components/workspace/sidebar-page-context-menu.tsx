'use client'

import { useEffect, useRef } from 'react'
import { PanelRightOpen, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarPageContextMenuProps {
  /** The path of the page the user right-clicked. */
  path: string
  /** Anchor in viewport coordinates (where the menu should appear). */
  position: { x: number; y: number } | null
  /** True when running inside Electron (window.markforge present). */
  isDesktop: boolean
  onOpenInSidePeek: (path: string) => void
  onOpenInNewWindow: (path: string) => void
  onDismiss: () => void
}

const MENU =
  'fixed z-50 w-56 rounded-md border bg-popover p-1 shadow-md'
const ITEM = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-foreground text-foreground'

/**
 * Right-click menu for a page row in the folder tree.
 *
 * Always offers "Open in side peek". Offers "Open in new window" on the web
 * only — Electron already has its own windowing story (IPC + system menu),
 * and surfacing a second web-style entry there would duplicate the
 * system-menu path that Electron already wires through IPC.
 */
export function SidebarPageContextMenu({
  path,
  position,
  isDesktop,
  onOpenInSidePeek,
  onOpenInNewWindow,
  onDismiss,
}: SidebarPageContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!position) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [position, onDismiss])

  if (!position) return null

  // Keep the menu inside the viewport — a right-click at the bottom-right
  // would otherwise bleed past the edge. `min(coord, viewport - size)`
  // shifts it up/left when there's no room.
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 768
  const MENU_W = 224
  const MENU_H = isDesktop ? 40 : 80
  const x = Math.min(position.x, viewportW - MENU_W - 8)
  const y = Math.min(position.y, viewportH - MENU_H - 8)

  return (
    <div
      ref={ref}
      role="menu"
      className={cn(MENU)}
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className={ITEM}
        onClick={() => {
          onOpenInSidePeek(path)
          onDismiss()
        }}
      >
        <PanelRightOpen className="size-3.5 text-muted-foreground" />
        <span>Open in side peek</span>
      </button>
      {!isDesktop && (
        <button
          type="button"
          role="menuitem"
          className={ITEM}
          onClick={() => {
            onOpenInNewWindow(path)
            onDismiss()
          }}
        >
          <ExternalLink className="size-3.5 text-muted-foreground" />
          <span>Open in new window</span>
        </button>
      )}
    </div>
  )
}
