'use client'

import { useState } from 'react'
import { Link2, FileText, ChevronDown, ChevronRight } from 'lucide-react'
import { MarkdownDocument } from '@/lib/file-store'
import type { OpenIntent } from '@/lib/tabs'
import { openHandlers } from './tab-gestures'

interface BacklinksPanelProps {
  activeDoc: MarkdownDocument
  allDocs: Record<string, MarkdownDocument>
  backlinksMap: Record<string, string[]>
  onSelectDoc: (path: string, intent: OpenIntent) => void
}

export function BacklinksPanel({ activeDoc, allDocs, backlinksMap, onSelectDoc }: BacklinksPanelProps) {
  const [isOpen, setIsOpen] = useState(true)

  // Check backlinks by document title or filename or path
  const docTitle = activeDoc.title
  const fileName = activeDoc.path.split('/').pop()?.replace('.md', '') || ''

  const referringPaths = Array.from(
    new Set([
      ...(backlinksMap[docTitle] || []),
      ...(backlinksMap[fileName] || []),
      ...(backlinksMap[activeDoc.path] || []),
    ])
  ).filter((p) => p !== activeDoc.path)

  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <div className="flex items-center gap-2">
          <Link2 className="size-4 text-primary" />
          <span>Backlinks ({referringPaths.length})</span>
        </div>
        {isOpen ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {isOpen && (
        <div className="mt-2 flex flex-col gap-2">
          {referringPaths.length > 0 ? (
            referringPaths.map((refPath) => {
              const refDoc = allDocs[refPath]
              const title = refDoc?.title || refPath

              return (
                <button
                  key={refPath}
                  type="button"
                  {...openHandlers((intent) => onSelectDoc(refPath, intent))}
                  title={`${title} — Ctrl/Cmd-click to open in a new tab`}
                  className="group flex flex-col items-start rounded-lg border bg-card p-2.5 text-left shadow-xs transition-all hover:border-primary/50 hover:shadow-md"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground group-hover:text-primary">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                    <span className="truncate">{title}</span>
                  </div>
                  {/*
                    The excerpt, not the body: the index carries a short one per
                    document precisely so this panel can show context without every
                    document's full text being in the browser.
                  */}
                  {refDoc?.excerpt && (
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      {refDoc.excerpt}
                    </p>
                  )}
                </button>
              )
            })
          ) : (
            <div className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
              No incoming links to this document.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
