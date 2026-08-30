'use client'

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { Plus, X } from 'lucide-react'
import type { DesktopTabsState, DesktopTabAction } from '@/lib/desktop-tabs'
import type { MarkdownDocument } from '@/lib/file-store'
import { cn } from '@/lib/utils'
import { PagePickerPopover } from './page-picker-popover'

const subscribeNever = () => () => {}

/**
 * Tab strip rendered at the top of an Electron window.
 *
 * Web mode never renders this — the in-app `lib/tabs.ts` already covers
 * navigation there. The `isDesktop` snapshot is read after mount so the
 * server-rendered HTML is identical to what the browser receives (no
 * hydration mismatch).
 */
export interface DesktopTabBarProps {
  state: DesktopTabsState
  /** Returns false when the action was refused (e.g. tab limit). */
  dispatch: (action: DesktopTabAction) => boolean
  /** Documents from the live index, used to look up titles. */
  documents: Record<string, MarkdownDocument>
  /** Open a document in the active tab of the in-app editor. */
  onActivate: (path: string) => void
  /** Maximum number of tabs; the `+` button is disabled at the cap. */
  limit: number
  /** Render a toast when the limit is hit. */
  onLimitReached: () => void
}

const TAB =
  'group flex h-7 max-w-[180px] min-w-[80px] items-center gap-1 rounded-t-md border-x border-t border-border bg-muted/40 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground cursor-pointer'
const TAB_ACTIVE = 'bg-background text-foreground hover:bg-background'

export function DesktopTabBar({
  state,
  dispatch,
  documents,
  onActivate,
  limit,
  onLimitReached,
}: DesktopTabBarProps) {
  const isDesktop = useSyncExternalStore(
    subscribeNever,
    () => Boolean(window.markforge),
    () => false
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)

  const onAdd = useCallback(() => {
    if (state.tabs.length >= limit) {
      onLimitReached()
      return
    }
    setPickerOpen((v) => !v)
  }, [state.tabs.length, limit, onLimitReached])

  if (!isDesktop) return null

  const titleFor = (path: string): string => {
    const doc = documents[path]
    if (doc?.title) return doc.title
    return path.replace(/^.*\//, '').replace(/\.md$/i, '')
  }

  return (
    <div className="relative flex h-9 shrink-0 items-end gap-1 border-b border-border bg-sidebar px-2 pt-1">
      {state.tabs.map((tab) => {
        const isActive = tab.id === state.activeId
        return (
          <button
            type="button"
            key={tab.id}
            className={cn(TAB, isActive && TAB_ACTIVE)}
            title={tab.path}
            onClick={() => {
              dispatch({ type: 'activate', id: tab.id })
              onActivate(tab.path)
            }}
            data-desktop-tab
            data-active={isActive ? 'true' : 'false'}
          >
            <span className="min-w-0 flex-1 truncate text-left">{titleFor(tab.path)}</span>
            <span
              role="button"
              aria-label="Close tab"
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                dispatch({ type: 'close', id: tab.id })
              }}
            >
              <X className="size-3" />
            </span>
          </button>
        )
      })}
      <button
        ref={addRef}
        type="button"
        className="flex size-7 shrink-0 items-center justify-center self-end rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
        title={state.tabs.length >= limit ? `Max ${limit} tabs` : 'Open page'}
        aria-label="Open page"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        disabled={state.tabs.length >= limit}
        onClick={onAdd}
        data-desktop-tab-add
      >
        <Plus className="size-3.5" />
      </button>
      <PagePickerPopover
        anchorRef={addRef}
        documents={documents}
        open={pickerOpen}
        onPick={(path) => {
          setPickerOpen(false)
          const ok = dispatch({ type: 'open', path })
          if (ok) onActivate(path)
          else onLimitReached()
        }}
        onDismiss={() => setPickerOpen(false)}
      />
    </div>
  )
}
