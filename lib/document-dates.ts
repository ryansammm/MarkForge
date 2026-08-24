import type { MarkdownDocument } from './file-store'

/**
 * The two dates a document has, and how to say them.
 *
 * They come from different places on purpose:
 *
 * - **Created** is frontmatter. It is written into the document the first time this
 *   app saves it (`ensureDocumentMeta`) and is never touched again, so it survives a
 *   move between storage backends, a restore from the trash, and a `git clone` — none
 *   of which a file's own timestamps survive.
 * - **Updated** is the stored object's modification time, read from the backend. It
 *   used to be `Date.now()` at the moment of the read, which meant opening a document
 *   was indistinguishable from editing it and everything always claimed to have
 *   changed "Just now".
 *
 * Shared by the reading view's header and the details panel so the two can never
 * disagree about a document's age.
 */

/** The document's own creation date, if it carries one. */
export function createdValue(document: MarkdownDocument): string | null {
  // `date:` as well as `created:`, because plenty of note templates use it and a
  // document that says when it was written should be believed either way.
  for (const key of ['created', 'date'] as const) {
    const value = document.frontmatter[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** A calendar date in the reader's locale, or the raw string when it is not a date. */
export function formatDay(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value.trim()
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

/** "12m ago" up to a day, a calendar date beyond it. */
export function formatRelative(value?: string): string | null {
  if (!value) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null

  const minutes = Math.floor((Date.now() - at.getTime()) / 60000)
  // Negative minutes mean a clock skew between this browser and the storage backend,
  // not a document from the future. "Just now" is the honest reading of both.
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export interface DocumentDates {
  /** What to put on the one line the reading view has room for. */
  label: string
  /** Both dates, for the tooltip — the line above can only carry one. */
  detail: string
}

/**
 * The single date line under a document's title.
 *
 * Created when the document knows it, because that is the date that does not move: a
 * header that changed every time the file was touched was reported as the reason this
 * line was worth reading at all. Updated is the fallback, and both are in the tooltip
 * either way.
 */
export function documentDates(document: MarkdownDocument): DocumentDates | null {
  const created = formatDay(createdValue(document))
  const updated = formatDay(document.updatedAt)
  const updatedRelative = formatRelative(document.updatedAt)

  if (!created && !updated) return null

  const detail = [
    created ? `Created ${created}` : null,
    updatedRelative ? `Updated ${updatedRelative}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    label: created ? `Created ${created}` : `Updated ${updated}`,
    detail,
  }
}
