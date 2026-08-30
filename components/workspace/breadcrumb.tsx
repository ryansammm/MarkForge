'use client'

import { ChevronRight, FileText } from 'lucide-react'
import type { MarkdownDocument } from '@/lib/file-store'
import { ancestorChain } from '@/lib/parent-tree'
import { openHandlers } from './tab-gestures'
import type { OpenIntent } from '@/lib/tabs'
import { cn } from '@/lib/utils'

/**
 * Walks the `parent_id` chain to the root and renders each segment as a
 * clickable link. The current document is the trailing segment, plain text.
 *
 * Cycles are silently broken (see `ancestorChain`) — a duplicate ancestor
 * would be confusing in a path; the more honest answer is to stop.
 */

interface BreadcrumbProps {
  current: MarkdownDocument
  allDocs: Record<string, MarkdownDocument>
  onNavigate: (path: string, intent: OpenIntent) => void
  className?: string
}

export function Breadcrumb({ current, allDocs, onNavigate, className }: BreadcrumbProps) {
  const chain = ancestorChain(allDocs, current)
  if (chain.length === 0) return null

  return (
    <nav
      aria-label="Page hierarchy"
      className={cn('flex flex-wrap items-center gap-1 text-xs text-muted-foreground', className)}
    >
      {chain.map((doc) => (
        <span key={doc.path} className="flex items-center gap-1">
          <button
            type="button"
            {...openHandlers((intent) => onNavigate(doc.path, intent))}
            className="rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
            title={doc.path}
          >
            {doc.title}
          </button>
          <ChevronRight className="size-3 shrink-0 opacity-50" aria-hidden />
        </span>
      ))}
      <span className="flex items-center gap-1 text-foreground">
        <FileText className="size-3" aria-hidden />
        <span className="font-medium">{current.title}</span>
      </span>
    </nav>
  )
}
