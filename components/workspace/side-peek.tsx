'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import type { MarkdownDocument } from '@/lib/file-store'
import { DocViewer } from './doc-viewer'
import { ResizeHandle } from './resize-handle'
import { usePersistedSize } from '@/lib/use-persisted'

/**
 * Mirrors the shape of `LoadedSource` in workspace-app.tsx. Duplicated
 * because the peek is mounted with a subset of the source fields
 * (read-only display needs `body`; `etag` and the rest stay in the
 * workspace). Kept loose so a future field change does not force a
 * refactor here.
 */
export interface SidePeekSource {
  path: string
  body: string
  raw: string
  etag?: string
}

/** Default peek width — chosen because most notes render cleanly at 576px,
 *  which is also the smallest breakpoint Tailwind's `md:` starts at. */
const DEFAULT_WIDTH = 576
const MIN_WIDTH = 280
/** Hard ceiling in pixels. The peek's `style.width` is also capped at 70%
 *  of the viewport in the resize handler — this is the absolute fallback
 *  for windows where the viewport cannot be measured yet. */
const ABSOLUTE_MAX_WIDTH = 1600

/**
 * 45%-width read-only overlay that shows a document on top of the
 * active tab. Opened from the block menu's "Open in side peek" action.
 *
 * Renders the same `DocViewer` the main reading view uses, so every
 * markdown feature (wikilinks, images, code blocks) behaves the same
 * way. The difference is purely the chrome: a title bar with the
 * document name and a close button, an Esc keybinding, and a draggable
 * left edge to resize the overlay.
 */
interface SidePeekProps {
  path: string
  documents: Record<string, MarkdownDocument>
  source: SidePeekSource | null
  onClose: () => void
  onNavigateWikilink: (target: string, intent: { newTab: boolean; background: boolean }) => void
  onNavigatePath: (path: string, intent?: { newTab: boolean; background: boolean }) => void
}

export function SidePeek({
  path,
  documents,
  source,
  onClose,
  onNavigateWikilink,
  onNavigatePath,
}: SidePeekProps) {
  // Esc closes. Bound at the document level so it works even when the
  // overlay is not focused.
  React.useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [onClose])

  // Persisted width with a hard pixel cap. The 70% of viewport clamp
  // lives in the resize handler (it needs the live viewport) so the
  // hook stays viewport-agnostic.
  const [width, setWidth] = usePersistedSize('markforge.sidePeek.width', DEFAULT_WIDTH, {
    min: MIN_WIDTH,
    max: ABSOLUTE_MAX_WIDTH,
  })
  const handleResize = React.useCallback(
    (next: number) => {
      const viewportMax = Math.floor(window.innerWidth * 0.7)
      const cap = Math.min(ABSOLUTE_MAX_WIDTH, viewportMax)
      setWidth(Math.min(cap, Math.max(MIN_WIDTH, Math.round(next))))
    },
    [setWidth]
  )

  const doc = documents[path] ?? null
  const title = doc?.title ?? path

  return (
    <div
      role="dialog"
      aria-label="Side peek"
      data-testid="side-peek"
      style={{ width }}
      className="absolute right-0 top-0 z-40 flex h-full min-w-[280px] flex-col border-l bg-background shadow-2xl"
    >
      <ResizeHandle
        width={width}
        min={MIN_WIDTH}
        max={Math.min(ABSOLUTE_MAX_WIDTH, Math.floor(typeof window !== 'undefined' ? window.innerWidth * 0.7 : ABSOLUTE_MAX_WIDTH))}
        onResize={handleResize}
        edge="left"
        label="side peek"
        defaultWidth={DEFAULT_WIDTH}
      />
      <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-sidebar/40 px-3 py-2">
        <div className="truncate text-sm font-medium text-foreground" title={path}>
          {title}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close side peek"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <DocViewer
          document={doc}
          allDocs={documents}
          onNavigateWikilink={onNavigateWikilink}
          onNavigatePath={onNavigatePath}
          body={source?.body ?? null}
          loading={!source}
          error={null}
          scrollFor={undefined}
          onScroll={(scrolledPath, _top) => {
            // Peek does not persist scroll position — every open starts
            // at the top of the document. The signature still has to
            // match the DocViewer's, so we accept the args and ignore.
            void scrolledPath
          }}
          tree={[]}
        />
      </div>
    </div>
  )
}
