'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { matchQuick, type VaultItem } from '@/lib/vault/items'
import { CLIPBOARD_CLEAR_SECONDS, copySecret } from '@/lib/vault/clipboard'
import { cn } from '@/lib/utils'

interface PasswordQuickSwitcherProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The unlocked items. Passing `null` means the vault is locked — the
   * switcher renders a single disabled row and the hotkey is a no-op.
   */
  items: VaultItem[] | null
}

/**
 * Spotlight-style quick switcher for the password manager.
 *
 * Hotkey: `Cmd/Ctrl-Shift-P`. Escape closes. Enter copies the highlighted
 * row's password; arrow keys move the highlight. The list is fuzzy-matched
 * by `matchQuick` against the same fields the full dialog searches on.
 *
 * Why this exists as a sibling of the dialog and not a mode of it: the
 * dialog is a heavy control — search, add, edit, delete, backup — and
 * a hotkey that opens the *whole* dialog to copy one password is a hotkey
 * nobody reaches for. A standalone dialog that opens, copies, closes is
 * the actual ergonomic win, and it costs a single component.
 */
export function PasswordQuickSwitcher({
  open,
  onOpenChange,
  items,
}: PasswordQuickSwitcherProps) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [lastOpen, setLastOpen] = useState(open)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset on open transition, in render so the cleared state is what
  // first paints when the dialog appears (see passwords-dialog for the
  // same pattern).
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setQuery('')
      setHighlight(0)
    }
  }

  const ranked = useMemo(() => (items ? matchQuick(items, query) : []), [items, query])
  const top = ranked.slice(0, 8)

  // Keep `highlight` in range as the result list shrinks. Set during
  // render so the visible row never points past the end of the list.
  if (top.length > 0 && highlight >= top.length) {
    setHighlight(Math.max(0, top.length - 1))
  }

  useEffect(() => {
    if (!open) return
    // Defer until after the dialog opens, otherwise the input steals focus
    // back from the autofocus the dialog performs.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  const close = () => onOpenChange(false)

  const copyAt = async (index: number) => {
    const target = top[index]
    if (!target) return
    try {
      await copySecret(target.password)
      toast.success(`Copied ${target.name} — clipboard clears in ${CLIPBOARD_CLEAR_SECONDS}s`)
      close()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(0, top.length - 1)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void copyAt(highlight)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[14vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Quick switcher"
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              items === null
                ? 'Unlock the password manager first'
                : top.length === 0
                  ? 'Type to search…'
                  : 'Search credentials…'
            }
            disabled={items === null}
            className="border-0 bg-transparent shadow-none focus-visible:ring-0"
            aria-label="Search credentials"
          />
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={close}
            title="Close"
            aria-label="Close quick switcher"
          >
            <X />
          </Button>
        </div>

        <ul className="max-h-72 overflow-y-auto p-1">
          {items === null ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Vault is locked. Press {HOTKEY_LABEL} to open the password manager.
            </li>
          ) : top.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">No matches.</li>
          ) : (
            top.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm',
                    index === highlight
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  )}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => void copyAt(index)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate font-medium">{item.name}</span>
                    {(item.username || item.url) && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {item.username}
                        {item.url ? ` · ${item.url}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">↵ copy</span>
                </button>
              </li>
            ))
          )}
        </ul>

        <p className="border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
          {HOTKEY_LABEL} to open · ↑↓ to move · ↵ to copy · esc to close
        </p>
      </div>
    </div>
  )
}

/** Human-readable hotkey label, swapped on the fly by the host. */
export const HOTKEY_LABEL = '\u2318\u21E7P' // ⌘⇧P

/**
 * The hotkey listener. Mounted at the workspace root, owns the open state,
 * and routes the keypress only when no input has focus. Mounts/dismounts
 * with the component, which is fine — there is only one workspace.
 */
export function usePasswordQuickSwitcherHotkey(
  items: VaultItem[] | null,
  onOpen: () => void
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (!event.shiftKey) return
      if (event.key.toLowerCase() !== 'p') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      event.preventDefault()
      onOpen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, onOpen])
}
