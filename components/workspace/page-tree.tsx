'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import type { MarkdownDocument } from '@/lib/file-store'
import { buildParentTree, type ParentTreeNode } from '@/lib/parent-tree'
import { openHandlers } from './tab-gestures'
import { cn } from '@/lib/utils'
import type { OpenIntent } from '@/lib/tabs'

/**
 * The page-in-page navigation view.
 *
 * Renders a tree of every document in the index, grouped by `parent_id`.
 * Coexists with the folder tree, which still drives file-system-level
 * operations (drag, drop, create). The page tree is the *logical* hierarchy:
 * what the user means when they say "child of X".
 *
 * A document without a stable `id` cannot have children, so it is rendered
 * as a leaf. The list is rebuilt from the index on every render — the
 * derivation is cheap and the result always matches what the index says.
 */

interface PageTreeProps {
  docs: Record<string, MarkdownDocument>
  activePath: string | null
  onNavigate: (path: string, intent: OpenIntent) => void
}

export function PageTree({ docs, activePath, onNavigate }: PageTreeProps) {
  const tree = buildParentTree(docs)
  if (tree.length === 0) return null

  return (
    <div className="mb-2 px-3">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Pages</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {tree.map((node) => (
          <TreeRow
            key={node.doc.path}
            node={node}
            depth={0}
            activePath={activePath}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  )
}

const ROW = 'group flex h-7 w-full items-center gap-1 rounded-md px-1.5 text-sm transition-colors'
const ROW_BUTTON = 'flex min-w-0 flex-1 items-center gap-1.5 text-left'
const ICON_BOX = 'flex size-4 shrink-0 items-center justify-center'
const TWISTY_BOX = 'flex size-3.5 shrink-0 items-center justify-center'

function TreeRow({
  node,
  depth,
  activePath,
  onNavigate,
}: {
  node: ParentTreeNode
  depth: number
  activePath: string | null
  onNavigate: (path: string, intent: OpenIntent) => void
}) {
  const hasChildren = node.children.length > 0
  const isActive = activePath === node.doc.path
  const [open, setOpen] = useState(true)

  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={cn(
          ROW,
          isActive
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-xs'
            : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
        )}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
      >
        <button
          type="button"
          onClick={() => (hasChildren ? setOpen((v) => !v) : undefined)}
          aria-expanded={hasChildren ? open : undefined}
          className={TWISTY_BOX}
        >
          {hasChildren ? (
            open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
          ) : null}
        </button>
        <button
          type="button"
          {...openHandlers((intent) => onNavigate(node.doc.path, intent))}
          className={ROW_BUTTON}
          title={`${node.doc.title}\n${node.doc.path}`}
        >
          <span className={ICON_BOX}>
            <FileText className={cn('size-3.5', isActive ? 'text-primary' : 'text-muted-foreground')} />
          </span>
          <span className="truncate">{node.doc.title}</span>
        </button>
      </div>
      {hasChildren && open && (
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TreeRow
              key={child.doc.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}
