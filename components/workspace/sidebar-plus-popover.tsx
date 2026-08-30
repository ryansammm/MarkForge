'use client'

import { useEffect, useRef, useState } from 'react'
import { FilePlus, Plus, BookPlus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarPlusPopoverProps {
  onNewPage: () => void
  onNewGrimoire: () => void
}

const POPOVER =
  'absolute right-0 top-full z-30 mt-1 w-48 rounded-md border bg-popover p-1 shadow-md'
const ITEM = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-foreground text-foreground'

/**
 * Single `+` button at the top of the folder tree. Opens a popover with two
 * actions: a new page in the active grimoire, and a new grimoire.
 *
 * Two items, not one — the same `+` doing two different things would need a
 * confirmation prompt or a route, both of which are worse than a click.
 */
export function SidebarPlusPopover({ onNewPage, onNewGrimoire }: SidebarPlusPopoverProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        className={cn(
          'flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'
        )}
        title="Create"
        aria-label="Create"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus className="size-3.5" />
      </button>
      {open && (
        <div role="menu" className={POPOVER}>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              setOpen(false)
              onNewPage()
            }}
          >
            <FilePlus className="size-3.5 text-muted-foreground" />
            <span>New page</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              setOpen(false)
              onNewGrimoire()
            }}
          >
            <BookPlus className="size-3.5 text-muted-foreground" />
            <span>New grimoire</span>
          </button>
        </div>
      )}
    </div>
  )
}
