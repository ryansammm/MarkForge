'use client'

import { MarkdownDocument } from '@/lib/file-store'
import { childrenOf } from '@/lib/parent-tree'
import { openHandlers } from './tab-gestures'
import type { OpenIntent } from '@/lib/tabs'

/**
 * Renders a "Child pages" section under the body of a document.
 *
 * Renderer-generated rather than written into the body: a child added later
 * would otherwise require re-writing the parent. The section is also
 * deliberately empty when the document has no children — the heading "Child
 * pages" is the affordance, and adding an empty one would train the eye to
 * ignore it.
 */

interface ChildPagesProps {
  parent: MarkdownDocument
  allDocs: Record<string, MarkdownDocument>
  onNavigate: (path: string, intent: OpenIntent) => void
}

export function ChildPagesSection({ parent, allDocs, onNavigate }: ChildPagesProps) {
  if (!parent.id) return null
  const children = childrenOf(allDocs, parent.id)
  if (children.length === 0) return null

  return (
    <section
      aria-label="Child pages"
      className="border-t pt-6"
    >
      <h2 className="font-serif text-xl font-semibold text-foreground">Child pages</h2>
      <ul className="mt-3 space-y-1">
        {children.map((child) => (
          <li key={child.path}>
            <button
              type="button"
              {...openHandlers((intent) => onNavigate(child.path, intent))}
              className="font-medium text-primary underline-offset-4 transition-colors hover:underline"
            >
              {child.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
