'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, FileText } from 'lucide-react'
import type { MarkdownDocument } from '@/lib/file-store'
import { cn } from '@/lib/utils'

interface PagePickerPopoverProps {
  /** The `+` button — clicks here should not close the popover. */
  anchorRef: React.RefObject<HTMLElement | null>
  documents: Record<string, MarkdownDocument>
  open: boolean
  onPick: (path: string) => void
  onDismiss: () => void
}

const WRAP = 'absolute right-0 top-full z-40 mt-1 flex w-72 flex-col overflow-hidden rounded-md border bg-popover shadow-md'
const ROW = 'flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-foreground'

/**
 * Search-as-you-type page picker.
 *
 * Anchored under the `+` button in the desktop tab bar. Filters the live
 * index by title (case-insensitive substring); pick a row to open that
 * page as a new tab. Click outside (other than the `+` button) or Esc
 * dismisses.
 */
export function PagePickerPopover({ anchorRef, documents, open, onPick, onDismiss }: PagePickerPopoverProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const prevOpen = useRef(open)

  useEffect(() => {
    if (open && !prevOpen.current) {
      // Reset on the open transition only, not on every render of the
      // popover. Deferred past render so it is not the synchronous
      // setState-in-effect the React 19 lint rule flags.
      queueMicrotask(() => setQuery(''))
      const t = window.setTimeout(() => inputRef.current?.focus(), 0)
      prevOpen.current = true
      return () => window.clearTimeout(t)
    }
    if (!open) prevOpen.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (wrapRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onDismiss()
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
  }, [open, onDismiss, anchorRef])

  if (!open) return null

  const q = query.trim().toLowerCase()
  const entries = Object.values(documents)
    .filter((doc) => !q || doc.title.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, 50)

  return (
    <div ref={wrapRef} role="menu" className={WRAP}>
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages…"
          className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {entries.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">No matches</div>
        ) : (
          entries.map((doc) => (
            <button
              key={doc.path}
              type="button"
              role="menuitem"
              className={cn(ROW)}
              onClick={() => onPick(doc.path)}
              title={doc.path}
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{doc.title || doc.path}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
