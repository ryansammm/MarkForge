'use client'

import type { MarkdownDocument } from '@/lib/file-store'
import { createdValue, formatDay, formatRelative } from '@/lib/document-dates'

/**
 * Created, updated, word count — the Details block from the original design.
 *
 * Everything here is derived from what the index already holds, so it costs no
 * request. Both dates are formatted by lib/document-dates.ts, which the reading
 * view's header uses too — the two panels describing the same document's age must
 * not be able to disagree about it.
 */

interface DetailsPanelProps {
  document: MarkdownDocument
}

export function DetailsPanel({ document }: DetailsPanelProps) {
  const created = formatDay(createdValue(document))
  const updated = formatRelative(document.updatedAt)
  // Counted server-side and carried in the index. The panel used to count the body
  // itself, which is one of the reasons the index had to ship one.
  const words = document.wordCount ?? 0

  const rows: Array<[string, string]> = []
  if (created) rows.push(['Created', created])
  if (updated) rows.push(['Updated', updated])
  rows.push(['Words', words.toLocaleString()])

  return (
    <section className="px-4 py-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Details
      </h2>
      <dl className="flex flex-col gap-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
