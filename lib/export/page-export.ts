/**
 * Page-level Markdown export.
 *
 * Two surfaces:
 *
 *   - `buildExportName(document)` turns a workspace-relative path
 *     into a clean filename for the user's filesystem (`notes/ideas.md`
 *     → `ideas.md`).
 *   - `downloadMarkdown(filename, content)` triggers a browser
 *     download via a transient anchor + `URL.createObjectURL`.
 *
 * The Electron desktop build re-uses the same name + content but
 * writes through `window.markforge.saveFile(...)` (a native
 * `dialog.showSaveDialog`) instead, because `<a download>` in
 * Electron lands in a default Downloads folder without the same
 * "save where?" affordance a native dialog gives the user. The
 * `downloadMarkdown` helper still works in Electron as a
 * fallback; the page menu's `Export` action picks one.
 */

import type { MarkdownDocument } from '../file-store'

/**
 * Filename for the export. The workspace stores everything as
 * `*.md`, so a path like `notes/2026/ideas.md` becomes `ideas.md`.
 * The directory tree is the workspace's concern, not the user's
 * filesystem when they pick `Save As…`.
 */
export function buildExportName(document: MarkdownDocument): string {
  const lastSlash = document.path.lastIndexOf('/')
  const basename = lastSlash >= 0 ? document.path.slice(lastSlash + 1) : document.path
  if (basename.toLowerCase().endsWith('.md')) return basename
  return `${basename}.md`
}

/**
 * Triggers a browser download of `content` as `filename`.
 *
 * The anchor is appended to the DOM, clicked, then removed: a
 * detached `<a>` works in Firefox but not in Safari, where the
 * `download` attribute is ignored on a node that has never been
 * in the document. `URL.revokeObjectURL` runs on the next tick so
 * the browser has the URL in hand when the download starts.
 */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
