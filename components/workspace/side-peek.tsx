'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import type { MarkdownDocument } from '@/lib/file-store'
import { DocViewer } from './doc-viewer'

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

/**
 * 45%-width read-only overlay that shows a document on top of the
 * active tab. Opened from the block menu's "Open in side peek" action.
 *
 * Renders the same `DocViewer` the main reading view uses, so every
 * markdown feature (wikilinks, images, code blocks) behaves the same
 * way. The difference is purely the chrome: a title bar with the
 * document name and a close button, and an Esc keybinding.
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

  const doc = documents[path] ?? null
  const title = doc?.title ?? path

  return (
    <div
      role="dialog"
      aria-label="Side peek"
      data-testid="side-peek"
      className="absolute right-0 top-0 z-40 flex h-full w-[45%] min-w-[320px] flex-col border-l bg-background shadow-2xl"
    >
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
          pageMenu={null}
        />
      </div>
    </div>
  )
}
